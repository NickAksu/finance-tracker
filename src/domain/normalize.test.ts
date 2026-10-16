import { describe, expect, it } from "vitest";
import type { AiItem, AiReceipt } from "../ai/types";
import { DEFAULT_CATEGORIES } from "./categories";
import { localToUtc, normalizeReceipt, parseLocalDateTime, resolvePurchasedAt, type RuleRef } from "./normalize";

const categories = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, code: c.code }));
const idOf = (code: string) => categories.find((c) => c.code === code)!.id;
const now = new Date("2026-10-08T12:00:00Z");
const opts = (rules: RuleRef[] = []) => ({ categories, rules, defaultCurrency: "BYN", timezone: "Europe/Minsk", now });

const item = (p: Partial<AiItem>): AiItem => ({
  name: "Товар",
  quantity: 1,
  price: null,
  discount: 0,
  line_total: null,
  category: "groceries",
  ...p,
});

const receipt = (p: Partial<AiReceipt>): AiReceipt => ({
  doc_type: "store_receipt",
  store_name: "Евроопт",
  purchased_at: "2026-10-05T14:32",
  currency: "BYN",
  total_amount: null,
  fee_amount: 0,
  erip_account: null,
  items: [],
  confidence: "high",
  reason: null,
  ...p,
});

describe("normalizeReceipt", () => {
  it("деньги, скидка, весовой товар, позиции", () => {
    const r = normalizeReceipt(
      receipt({
        total_amount: 7.56,
        items: [
          item({ name: "Бананы", quantity: 0.532, price: 4.99, line_total: null }),
          item({ name: "Молоко 0.9л", quantity: 2, price: 2.5, discount: 0.3 }),
          item({ name: "  ", line_total: 1 }),
          item({ name: "Пакет", quantity: 0, price: 0.21, line_total: 0.21 }),
        ],
      }),
      opts(),
    );
    expect(r.items.map((i) => [i.position, i.name, i.quantity, i.totalMinor, i.discountMinor])).toEqual([
      [1, "Бананы", 0.532, 265, 0],
      [2, "Молоко 0.9л", 2, 470, 30],
      [3, "Пакет", 1, 21, 0],
    ]);
    expect(r.totalMinor).toBe(756);
    expect(r.hasSumMismatch).toBe(false);
    expect(r.currency).toBe("BYN");
  });

  it("комиссия ЕРИП прибавляется к самой крупной позиции", () => {
    const r = normalizeReceipt(
      receipt({
        doc_type: "erip",
        store_name: "ЖЭС №5",
        total_amount: 101.5,
        fee_amount: 1.5,
        erip_account: "123-456",
        items: [
          item({ name: "Отопление", line_total: 60, category: "utilities" }),
          item({ name: "Вода", line_total: 40, category: "utilities" }),
        ],
      }),
      opts(),
    );
    expect(r.items.map((i) => i.totalMinor)).toEqual([6150, 4000]);
    expect(r.totalMinor).toBe(10150);
    expect(r.hasSumMismatch).toBe(false);
    expect(r.eripAccount).toBe("123-456");
  });

  it("без позиций — одна позиция на всю сумму", () => {
    const r = normalizeReceipt(receipt({ doc_type: "erip", store_name: "МТС", total_amount: 20.4, fee_amount: 0.4 }), opts());
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: "МТС", totalMinor: 2040, categoryId: idOf("other") });
    const noStore = normalizeReceipt(receipt({ store_name: null, total_amount: 5 }), opts());
    expect(noStore.items[0]?.name).toBe("Платёж");
  });

  it("итог null → сумма позиций", () => {
    const r = normalizeReceipt(receipt({ items: [item({ line_total: 1.1 }), item({ line_total: 2.2 })] }), opts());
    expect(r.totalMinor).toBe(330);
  });

  it("расхождение суммы > 1 %", () => {
    const base = { items: [item({ line_total: 98 })] };
    expect(normalizeReceipt(receipt({ ...base, total_amount: 100 }), opts()).hasSumMismatch).toBe(true);
    expect(normalizeReceipt(receipt({ ...base, total_amount: 98.9 }), opts()).hasSumMismatch).toBe(false);
    // Маленький чек: 1 копейка — не расхождение
    expect(normalizeReceipt(receipt({ items: [item({ line_total: 0.5 })], total_amount: 0.51 }), opts()).hasSumMismatch).toBe(false);
  });

  it("приоритет правил: л/с ЕРИП > позиция > магазин > ИИ", () => {
    const rules: RuleRef[] = [
      { id: 10, matchType: "store", pattern: "белфармация", categoryId: idOf("health") },
      { id: 11, matchType: "item", pattern: "крем детский", categoryId: idOf("kids") },
      { id: 12, matchType: "erip_account", pattern: "1234567", categoryId: idOf("utilities") },
    ];
    const pharmacy = normalizeReceipt(
      receipt({
        store_name: "Белфармация",
        items: [
          item({ name: "Крем детский 50 мл", line_total: 5, category: "beauty" }),
          item({ name: "Нурофен", line_total: 7, category: "health" }),
          item({ name: "Прочее", line_total: 1, category: "unknown-code" }),
        ],
      }),
      opts(rules),
    );
    expect(pharmacy.items.map((i) => [i.categoryId, i.categorySource, i.ruleId])).toEqual([
      [idOf("kids"), "rule", 11],
      [idOf("health"), "rule", 10],
      [idOf("health"), "rule", 10],
    ]);
    expect(pharmacy.appliedRuleIds.sort()).toEqual([10, 11]);

    const erip = normalizeReceipt(
      receipt({
        doc_type: "erip",
        store_name: "Белфармация",
        erip_account: "12-34-567",
        items: [item({ name: "Крем детский", line_total: 5, category: "telecom" })],
      }),
      opts(rules),
    );
    expect(erip.items[0]).toMatchObject({ categoryId: idOf("utilities"), ruleId: 12, categorySource: "rule" });

    const ai = normalizeReceipt(receipt({ items: [item({ name: "X", line_total: 1, category: "nope" })] }), opts());
    expect(ai.items[0]).toMatchObject({ categoryId: idOf("other"), categorySource: "ai", ruleId: null });
  });

  it("валюта: верхний регистр или по умолчанию", () => {
    expect(normalizeReceipt(receipt({ currency: "usd", total_amount: 1 }), opts()).currency).toBe("USD");
    expect(normalizeReceipt(receipt({ currency: null, total_amount: 1 }), opts()).currency).toBe("BYN");
  });

  it("not_purchase не нормализуется", () => {
    expect(() => normalizeReceipt(receipt({ doc_type: "not_purchase" }), opts())).toThrow();
  });
});

describe("время покупки", () => {
  it("Europe/Minsk = UTC+3", () => {
    expect(resolvePurchasedAt("2026-10-05T14:32", "Europe/Minsk", now)).toBe("2026-10-05T11:32:00.000Z");
    expect(resolvePurchasedAt("2026-01-05", "Europe/Minsk", now)).toBe("2026-01-05T09:00:00.000Z");
    expect(resolvePurchasedAt("05.10.2026 00:15", "Europe/Minsk", now)).toBe("2026-10-04T21:15:00.000Z");
  });

  it("зоны с переходом на летнее время", () => {
    expect(resolvePurchasedAt("2026-07-01T12:00", "Europe/Berlin", now)).toBe("2026-07-01T10:00:00.000Z");
    expect(resolvePurchasedAt("2026-01-01T12:00", "Europe/Berlin", now)).toBe("2026-01-01T11:00:00.000Z");
    expect(resolvePurchasedAt("2026-03-01T12:00", "America/New_York", now)).toBe("2026-03-01T17:00:00.000Z");
    expect(resolvePurchasedAt("2026-03-10T12:00", "America/New_York", now)).toBe("2026-03-10T16:00:00.000Z");
    expect(new Date(localToUtc(parseLocalDateTime("2026-03-29T02:30")!, "Europe/Berlin")).toISOString()).toMatch(/^2026-03-29T0[01]:30/);
  });

  it("мусор, отсутствие и будущее → now", () => {
    expect(resolvePurchasedAt(null, "Europe/Minsk", now)).toBe(now.toISOString());
    expect(resolvePurchasedAt("вчера", "Europe/Minsk", now)).toBe(now.toISOString());
    expect(resolvePurchasedAt("2026-02-31T10:00", "Europe/Minsk", now)).toBe(now.toISOString());
    expect(resolvePurchasedAt("2026-10-10T10:00", "Europe/Minsk", now)).toBe(now.toISOString());
    // Сегодня вечером по Минску (в пределах суток вперёд) — допустимо
    expect(resolvePurchasedAt("2026-10-08T20:00", "Europe/Minsk", now)).toBe("2026-10-08T17:00:00.000Z");
  });
});
