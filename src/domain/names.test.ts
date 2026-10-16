import { describe, expect, it } from "vitest";
import { normalizeAccount, normalizeName } from "./names";

describe("normalizeName", () => {
  it.each([
    ["Молоко «Савушкин» 3,2% 0.9л", "молоко савушкин"],
    ["МОЛОКО САВУШКИН 3.2% 0,9 Л", "молоко савушкин"],
    ["Ёгурт Тёма 500 г", "егурт тема"],
    ["Пакет №1", "пакет"],
    ["Сок \"Rich\" 1л x2", "сок rich"],
    ["4810268031557 Хлеб Нарочанский", "хлеб нарочанский"],
    ["Салфетки влажные 2шт", "салфетки влажные"],
    ["Яйца С1 10", "яйца с1"],
    ["  Кофе,   молотый!! ", "кофе молотый"],
    ["Евроопт", "евроопт"],
    ["ООО \"Санта Ритейл\"", "ооо санта ритейл"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("не возвращает пустую строку", () => {
    expect(normalizeName("500 г")).toBe("500 г");
  });
});

describe("normalizeAccount", () => {
  it("оставляет только буквы и цифры", () => {
    expect(normalizeAccount(" 12-345 678 ")).toBe("12345678");
    expect(normalizeAccount("ab/12")).toBe("AB12");
  });
});
