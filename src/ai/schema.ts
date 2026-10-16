// Валидация ответа модели (zod) и JSON-схема для Gemini responseSchema.
// Снисходительны к «неряшливым» значениям (строки-числа, null, неизвестная категория),
// но отвергаем структурно сломанный ответ (не объект, нет/чужой doc_type, items не массив).

import { z } from "zod";
import { parseDecimal } from "../domain/money";
import { OTHER_CATEGORY_CODE } from "../domain/categories";
import type { AiReceipt } from "./types";

const DOC_TYPES = ["store_receipt", "erip", "online_order", "not_purchase"] as const;
const CONFIDENCE = ["low", "medium", "high"] as const;

const isNullish = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && /^\s*(|null|none|n\/a|-|—)\s*$/i.test(v));

/** Число из number | "12,50" | "1 234.56 BYN"; null-подобное → null; прочее оставляем как есть (провалит схему). */
const toNumberOrNull = (v: unknown): unknown => {
  if (isNullish(v)) return null;
  if (typeof v === "string") return parseDecimal(v) ?? v;
  return v;
};

const nullableNumber = z.preprocess(toNumberOrNull, z.number().nullable());
/** Число с подстановкой значения по умолчанию для null/пропуска. */
const numberOr = (fallback: number) =>
  z.preprocess((v) => toNumberOrNull(v) ?? fallback, z.number());

const nullableString = z.preprocess((v) => {
  if (isNullish(v)) return null;
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v.trim() : v;
}, z.string().nullable());

const lowerEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(values));

export function aiReceiptSchema(allowedCategoryCodes: readonly string[]) {
  const allowed = new Set(allowedCategoryCodes);
  const category = z.preprocess((v) => {
    const code = typeof v === "string" ? v.trim().toLowerCase() : "";
    return allowed.has(code) ? code : OTHER_CATEGORY_CODE;
  }, z.string());

  const item = z.object({
    name: z.preprocess((v) => (isNullish(v) ? "" : typeof v === "number" ? String(v) : v), z.string().transform((s) => s.trim())),
    quantity: numberOr(1),
    price: nullableNumber,
    discount: numberOr(0).transform(Math.abs),
    line_total: nullableNumber,
    category,
  });

  return z.object({
    doc_type: lowerEnum(DOC_TYPES),
    store_name: nullableString,
    purchased_at: nullableString,
    currency: nullableString.transform((s) => {
      const c = s?.toUpperCase();
      return c && /^[A-Z]{3}$/.test(c) ? c : null;
    }),
    total_amount: nullableNumber,
    fee_amount: numberOr(0).transform(Math.abs),
    erip_account: nullableString,
    items: z.preprocess((v) => (isNullish(v) ? [] : v), z.array(item)),
    confidence: lowerEnum(CONFIDENCE).catch("low"),
    reason: nullableString,
  }) satisfies z.ZodType<AiReceipt, unknown>;
}

export type ParseJsonResult = { ok: true; receipt: AiReceipt } | { ok: false; error: string };

/** Текст модели → AiReceipt: снимает ```json-обёртку, вытаскивает {...}, валидирует. */
export function parseAiJson(text: string, allowedCategoryCodes: readonly string[]): ParseJsonResult {
  let s = text.trim();
  const fence = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1]!;
  let data: unknown;
  try {
    data = JSON.parse(s);
  } catch {
    // Модель могла обрамить JSON текстом — берём от первой { до последней }
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, error: "ответ не JSON" };
    try {
      data = JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      return { ok: false, error: `ответ не JSON: ${(e as Error).message}` };
    }
  }
  if (Array.isArray(data) && data.length === 1) data = data[0];
  const parsed = aiReceiptSchema(allowedCategoryCodes).safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `ответ не прошёл схему: ${issues}` };
  }
  return { ok: true, receipt: parsed.data };
}

/** Схема ответа для Gemini (generationConfig.responseSchema, OpenAPI-подмножество v1beta). */
export function geminiResponseSchema(allowedCategoryCodes: readonly string[]): Record<string, unknown> {
  const num = (description?: string) => ({ type: "NUMBER", ...(description ? { description } : {}) });
  const nullable = <T extends object>(s: T) => ({ ...s, nullable: true });
  return {
    type: "OBJECT",
    properties: {
      doc_type: { type: "STRING", format: "enum", enum: [...DOC_TYPES] },
      store_name: nullable({ type: "STRING" }),
      purchased_at: nullable({ type: "STRING", description: "YYYY-MM-DDTHH:mm or YYYY-MM-DD, local time as printed" }),
      currency: nullable({ type: "STRING", description: "ISO 4217" }),
      erip_account: nullable({ type: "STRING" }),
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            quantity: num(),
            price: nullable(num("unit price")),
            discount: num("positive, 0 if none"),
            line_total: nullable(num("after discount")),
            category: { type: "STRING", format: "enum", enum: [...allowedCategoryCodes] },
          },
          required: ["name", "quantity", "price", "discount", "line_total", "category"],
          propertyOrdering: ["name", "quantity", "price", "discount", "line_total", "category"],
        },
      },
      fee_amount: num("commission/service fee not included in items, 0 if none"),
      total_amount: nullable(num("actually charged, incl. fee")),
      confidence: { type: "STRING", format: "enum", enum: [...CONFIDENCE] },
      reason: nullable({ type: "STRING" }),
    },
    required: [
      "doc_type",
      "store_name",
      "purchased_at",
      "currency",
      "erip_account",
      "items",
      "fee_amount",
      "total_amount",
      "confidence",
      "reason",
    ],
    propertyOrdering: [
      "doc_type",
      "store_name",
      "purchased_at",
      "currency",
      "erip_account",
      "items",
      "fee_amount",
      "total_amount",
      "confidence",
      "reason",
    ],
  };
}

/** Та же схема в стандартном JSON Schema (для Workers AI response_format). */
export function jsonSchemaForReceipt(allowedCategoryCodes: readonly string[]): Record<string, unknown> {
  const nullableNum = { type: ["number", "null"] };
  const nullableStr = { type: ["string", "null"] };
  return {
    type: "object",
    properties: {
      doc_type: { type: "string", enum: [...DOC_TYPES] },
      store_name: nullableStr,
      purchased_at: nullableStr,
      currency: nullableStr,
      erip_account: nullableStr,
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            quantity: { type: "number" },
            price: nullableNum,
            discount: { type: "number" },
            line_total: nullableNum,
            category: { type: "string", enum: [...allowedCategoryCodes] },
          },
          required: ["name", "quantity", "price", "discount", "line_total", "category"],
        },
      },
      fee_amount: { type: "number" },
      total_amount: nullableNum,
      confidence: { type: "string", enum: [...CONFIDENCE] },
      reason: nullableStr,
    },
    required: ["doc_type", "items", "total_amount", "confidence"],
  };
}
