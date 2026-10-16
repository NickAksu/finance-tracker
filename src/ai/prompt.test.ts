import { describe, expect, it } from "vitest";
import { buildPrompt, localNow } from "./prompt";

const ctx = {
  categories: [
    { code: "groceries", name: "Продукты", description: "еда и напитки" },
    { code: "pets", name: "Питомцы", description: null },
    { code: "other", name: "Другое", description: "всё остальное" },
  ],
  currency: "BYN",
  timezone: "Europe/Minsk",
  now: new Date("2026-10-08T21:30:00Z"),
};

describe("buildPrompt", () => {
  it("содержит категории, валюту и локальную дату", () => {
    const p = buildPrompt(ctx);
    expect(p).toContain("- groceries: Продукты — еда и напитки");
    expect(p).toContain("- pets: Питомцы\n");
    expect(p).toContain("Default currency: BYN");
    expect(p).toContain("2026-10-09 00:30");
    expect(p).toContain("not_purchase");
    expect(p).not.toContain("images of ONE document");
  });

  it("подсказка про склейку нескольких картинок", () => {
    expect(buildPrompt(ctx, 3)).toContain("There are 3 images of ONE document");
  });

  it("localNow", () => {
    expect(localNow(new Date("2026-01-01T00:00:00Z"), "Europe/Minsk")).toBe("2026-01-01 03:00");
  });
});
