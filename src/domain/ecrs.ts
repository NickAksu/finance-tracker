// Разбор страницы mch.ecrs.by. Сайт иногда отдаёт UTF-8, прочитанный как CP866:
// кириллица приходит «кракозябрами», латиница и цифры остаются на месте.

import type { AiReceipt } from "../ai/types";
import { OTHER_CATEGORY_CODE } from "./categories";
import { parseDecimal } from "./money";

const ECRS_URL = /(?:https?:\/\/)?mch\.ecrs\.by\/([0-9a-f]{24})\b/i;
const BARE_UID = /^[0-9a-f]{24}$/i;

const cp866Byte = buildCp866ByteMap();

/** UID из текста QR. Принимает ссылку и голый 24-значный номер. */
export function ecrsUidFromTexts(texts: readonly string[]): string | null {
  for (const text of texts) {
    const raw = text.trim();
    const fromUrl = ECRS_URL.exec(raw)?.[1];
    if (fromUrl) return fromUrl.toUpperCase();
    if (BARE_UID.test(raw)) return raw.toUpperCase();
  }
  return null;
}

/** Если страница пришла в кодировке CP866-поверх-UTF-8, возвращает нормальный HTML. */
export function repairEcrsHtml(html: string): string {
  if (html.includes("ИТОГО") || html.includes("УНП")) return html;
  const bytes: number[] = [];
  for (const ch of html) {
    const byte = cp866Byte.get(ch);
    if (byte === undefined) return html;
    bytes.push(byte);
  }
  try {
    const fixed = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
    if (fixed.includes("ИТОГО") || fixed.includes("УНП")) return fixed;
  } catch {
    // байты не сложились в UTF-8 — оставляем как есть
  }
  return html;
}

/** Страница электронного чека → тот же контракт, что у распознавания фото. Категории потом уточняют правила. */
export function parseEcrsHtml(html: string): AiReceipt | null {
  const rows = rowsOf(repairEcrsHtml(html));
  if (rows.length === 0) return null;

  const items: AiReceipt["items"] = [];
  let store: string | null = null;
  let pending: string | null = null;
  let paid: number | null = null;
  let subtotal: number | null = null;
  let purchased: string | null = null;
  let purchasedDotted = false;

  for (const cells of rows) {
    const price = parsePriceRow(cells);
    const text = rowText(cells);
    if (price && pending) {
      items.push({
        name: pending,
        quantity: price.quantity,
        price: price.price,
        discount: 0,
        line_total: price.total,
        category: OTHER_CATEGORY_CODE,
      });
      pending = null;
      continue;
    }
    if (!text) continue;
    store ??= text;

    const when = findWhen(text);
    if (when && (when.dotted || !purchasedDotted)) {
      purchased = when.value;
      purchasedDotted = when.dotted;
    }

    const upper = text.toUpperCase();
    if (upper.startsWith("ИТОГО К ОПЛАТЕ")) paid = lastMoney(text);
    else if (upper.startsWith("ИТОГО")) subtotal = lastMoney(text);

    if (price || isHeader(upper)) {
      pending = null;
      continue;
    }
    const name = stripBarcode(text);
    pending = name || null;
  }

  const total = paid ?? subtotal;
  if (items.length === 0 && total == null) return null;

  const itemsCents = items.reduce((sum, item) => sum + Math.round((item.line_total ?? 0) * 100), 0);
  const totalCents = total == null ? itemsCents : Math.round(total * 100);
  const mismatch = items.length > 0 && Math.abs(itemsCents - totalCents) > 1;

  return {
    doc_type: "store_receipt",
    store_name: store,
    purchased_at: purchased,
    currency: "BYN",
    total_amount: total ?? itemsCents / 100,
    fee_amount: 0,
    erip_account: null,
    items,
    confidence: mismatch ? "medium" : "high",
    reason: null,
  };
}

function buildCp866ByteMap(): Map<string, number> {
  const decode = new TextDecoder("ibm866");
  const map = new Map<string, number>();
  for (let i = 0; i < 256; i++) map.set(decode.decode(Uint8Array.of(i)), i);
  return map;
}

function rowsOf(html: string): string[][] {
  const withoutNoise = html.replace(/<img\b[^>]*>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n");
  const rows: string[][] = [];
  for (const tr of withoutNoise.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const td of (tr[1] ?? "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
      cells.push(clean(decodeEntities((td[1] ?? "").replace(/<[^>]+>/g, ""))));
    }
    if (cells.some((cell) => cell)) rows.push(cells);
  }
  return rows;
}

function rowText(cells: readonly string[]): string {
  return clean(cells.filter(Boolean).join(" "));
}

function clean(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n+/g, " ")
    .replace(/^\*+\s*|\s*\*+$/g, "")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/gi, "&");
}

function stripBarcode(name: string): string {
  return name.replace(/\s+\d{8,14}$/, "").trim();
}

function parsePriceRow(cells: readonly string[]): { price: number; quantity: number; total: number } | null {
  const parts = cells.map((cell) => cell.trim()).filter(Boolean);
  const qtyIndex = parts.findIndex((part) => /^x\s*\d/i.test(part));
  if (qtyIndex < 0) return null;
  const quantity = parseDecimal(parts[qtyIndex]!.replace(/^x/i, ""));
  const amounts = parts.filter((_, index) => index !== qtyIndex).map((part) => parseDecimal(part));
  if (quantity == null || quantity <= 0 || amounts.length === 0 || amounts.some((amount) => amount == null)) return null;
  const price = amounts[0]!;
  const total = amounts[amounts.length - 1]!;
  return { price, quantity: Math.round(quantity * 1000) / 1000, total };
}

function lastMoney(text: string): number | null {
  const match = /(\d+(?:[.,]\d{1,2})?)\s*$/.exec(text);
  return match?.[1] ? parseDecimal(match[1]) : null;
}

function findWhen(text: string): { dotted: boolean; value: string } | null {
  const dotted = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const dottedStamp = dotted ? stamp(dotted) : "";
  if (dottedStamp) return { dotted: true, value: dottedStamp };
  const dashed = /(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const dashedStamp = dashed ? stamp(dashed) : "";
  if (dashedStamp) return { dotted: false, value: dashedStamp };
  return null;
}

function stamp(match: RegExpExecArray): string {
  const day = match[1];
  const month = match[2];
  const year = match[3];
  const hour = match[4];
  const minute = match[5];
  if (!day || !month || !year || !hour || !minute) return "";
  return `${day}.${month}.${year} ${hour}:${minute}:${match[6] ?? "00"}`;
}

function isHeader(upper: string): boolean {
  return (
    upper.startsWith("ИТОГО") ||
    upper.startsWith("УНП") ||
    upper.startsWith("ПЛАТЕЖНЫЙ") ||
    upper.startsWith("N ДОК") ||
    upper.startsWith("№ ДОК") ||
    upper.startsWith("УИ ") ||
    upper.startsWith("КСО") ||
    upper.startsWith("СПАСИБО") ||
    upper.startsWith("КАССИР") ||
    upper.startsWith("БАНК") ||
    upper.startsWith("НАЛИЧ") ||
    upper.startsWith("РН СККО") ||
    upper.includes(" ПРД ")
  );
}
