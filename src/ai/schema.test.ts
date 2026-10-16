import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "../domain/categories";
import { geminiResponseSchema, parseAiJson } from "./schema";

const codes = DEFAULT_CATEGORIES.map((c) => c.code);

describe("parseAiJson", () => {
  it("снисходителен к неряшливым значениям", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        doc_type: "Store_Receipt",
        store_name: "  Евроопт ",
        purchased_at: "",
        currency: "byn",
        total_amount: "1 234,50",
        erip_account: 1234567,
        items: [
          { name: "Хлеб", quantity: "1", price: "1,99", discount: "-0,20", line_total: "1.79", category: "Groceries" },
          { name: "Что-то", price: null, line_total: 3, category: "alcohol" },
        ],
        confidence: "very high",
        extra: "игнорируется",
      }) +
      "\n```";
    const r = parseAiJson(text, codes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt).toEqual({
      doc_type: "store_receipt",
      store_name: "Евроопт",
      purchased_at: null,
      currency: "BYN",
      total_amount: 1234.5,
      fee_amount: 0,
      erip_account: "1234567",
      items: [
        { name: "Хлеб", quantity: 1, price: 1.99, discount: 0.2, line_total: 1.79, category: "groceries" },
        { name: "Что-то", quantity: 1, price: null, discount: 0, line_total: 3, category: "other" },
      ],
      confidence: "low",
      reason: null,
    });
  });

  it("достаёт JSON из текста вокруг", () => {
    const r = parseAiJson('Вот результат: {"doc_type":"not_purchase","reason":"корзина"} спасибо', codes);
    expect(r.ok && r.receipt.doc_type).toBe("not_purchase");
    expect(r.ok && r.receipt.items).toEqual([]);
  });

  it.each([
    ["не JSON", "привет"],
    ["не объект", '"store_receipt"'],
    ["нет doc_type", '{"items":[]}'],
    ["чужой doc_type", '{"doc_type":"invoice","items":[]}'],
    ["items не массив", '{"doc_type":"erip","items":"Отопление"}'],
    ["item не объект", '{"doc_type":"erip","items":["Отопление"]}'],
    ["сумма — текст", '{"doc_type":"erip","items":[],"total_amount":"двадцать"}'],
  ])("отвергает: %s", (_, text) => {
    expect(parseAiJson(text, codes).ok).toBe(false);
  });
});

describe("geminiResponseSchema", () => {
  it("категории — enum, nullable-поля", () => {
    const s = geminiResponseSchema(["groceries", "other"]) as any;
    expect(s.properties.items.items.properties.category.enum).toEqual(["groceries", "other"]);
    expect(s.properties.doc_type.enum).toContain("not_purchase");
    expect(s.properties.total_amount.nullable).toBe(true);
    expect(s.required).toContain("doc_type");
  });
});
