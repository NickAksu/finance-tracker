import { describe, expect, it } from "vitest";
import { OTHER_CATEGORY_CODE } from "./categories";
import { ecrsUidFromTexts, parseEcrsHtml } from "./ecrs";
import { ECRS_SAMPLE_HTML } from "./ecrs-sample";
import { normalizeReceipt } from "./normalize";

describe("электронный чек", () => {
  it("достаёт номер из ссылки QR", () => {
    expect(ecrsUidFromTexts(["https://mch.ecrs.by/396da58c6f9c99bf071931bd"])).toBe("396DA58C6F9C99BF071931BD");
    expect(ecrsUidFromTexts(["просто текст", "396DA58C6F9C99BF071931BD"])).toBe("396DA58C6F9C99BF071931BD");
    expect(ecrsUidFromTexts(["4810410132088"])).toBeNull();
  });

  it("разбирает страницу чека", () => {
    const receipt = parseEcrsHtml(ECRS_SAMPLE_HTML);
    expect(receipt?.store_name).toBe('ООО "ГРИНРОЗНИЦА"');
    expect(receipt?.total_amount).toBe(19.5);
    expect(receipt?.purchased_at).toBe("19.10.2026 22:27:07");
    expect(receipt?.currency).toBe("BYN");
    expect(receipt?.items.map((item) => item.name)).toEqual([
      "Конфеты Коммунарка Мишка на поляне. Золотая коллек",
      "Салфетки GrandPero non-stop Микс 2сл 200 шт",
      "Печенье Затяжное Любятово Постное",
      "Напиток овсяный Немолоко классический лайт для дет",
    ]);
    expect(receipt?.items.every((item) => item.category === OTHER_CATEGORY_CODE)).toBe(true);

    const normalized = normalizeReceipt(receipt!, {
      categories: [{ id: 1, code: OTHER_CATEGORY_CODE }],
      rules: [],
      defaultCurrency: "BYN",
      timezone: "Europe/Minsk",
      now: new Date("2026-10-22T08:00:00Z"),
    });
    expect(normalized.totalMinor).toBe(1950);
    expect(normalized.items).toHaveLength(4);
    expect(normalized.hasSumMismatch).toBe(false);
    expect(normalized.purchasedAt).toBe("2026-10-19T19:27:07.000Z");
  });

  it("чинит страницу, которую прочитали как CP866", () => {
    const broken = new TextDecoder("ibm866").decode(new TextEncoder().encode(ECRS_SAMPLE_HTML));
    expect(broken).not.toContain("ИТОГО");
    expect(parseEcrsHtml(broken)?.total_amount).toBe(19.5);
  });
});
