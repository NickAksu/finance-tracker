import { describe, expect, it } from "vitest";
import { formatMoney, parseDecimal, toMinor } from "./money";

describe("toMinor", () => {
  it("округляет половину от нуля и гасит шум float", () => {
    expect(toMinor(12.5)).toBe(1250);
    expect(toMinor(1.005)).toBe(101);
    expect(toMinor(12.345000001)).toBe(1235);
    expect(toMinor(12.344999)).toBe(1234);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(-1.005)).toBe(-101);
    expect(toMinor(0)).toBe(0);
    expect(toMinor(Number.NaN)).toBe(0);
  });
});

describe("formatMoney", () => {
  it("русский формат с неразрывными пробелами", () => {
    expect(formatMoney(123456, "BYN")).toBe("1 234,56 BYN");
    expect(formatMoney(5, "BYN")).toBe("0,05 BYN");
    expect(formatMoney(100000000, "USD")).toBe("1 000 000,00 USD");
    expect(formatMoney(-250, "BYN")).toBe("-2,50 BYN");
  });
});

describe("parseDecimal", () => {
  it("понимает разные записи", () => {
    expect(parseDecimal("12,50")).toBe(12.5);
    expect(parseDecimal("1 234,56")).toBe(1234.56);
    expect(parseDecimal("1 234.56 BYN")).toBe(1234.56);
    expect(parseDecimal("1.234,56")).toBe(1234.56);
    expect(parseDecimal("3,00 р.")).toBe(3);
    expect(parseDecimal("0,532")).toBe(0.532);
    expect(parseDecimal("-2")).toBe(-2);
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });
});
