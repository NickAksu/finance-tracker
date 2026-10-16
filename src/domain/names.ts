// Нормализация названий для ключей правил категорий («по позиции», «по магазину», «по л/с ЕРИП»).

// Количество с единицей: 0.9кг, 1 л, 500 г, 2шт, 10 уп, 1,5L
const QTY_UNIT =
  /(^|[^\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:кг|гр|г|мг|л|мл|шт|уп|пак|м|см|мм|kg|gr|g|ml|l|pcs|pc)\.?(?![\p{L}\p{N}])/gu;
// Проценты: 3.2%, 15 %
const PERCENT = /(^|[^\p{L}\p{N}])\d+(?:[.,]\d+)?\s*%/gu;
// Множители: x2, х2, *2, 2x (кириллическая «х» тоже)
const MULTIPLIER = /(^|[^\p{L}\p{N}])(?:[xх*]\s*\d+|\d+\s*[xх*])(?![\p{L}\p{N}])/gu;
// Номера и артикулы: №1, N 5, арт. 123456
const NUMBER_SIGN = /(?:№|\bn\s*(?=\d)|арт\.?|артикул|код)\s*\d+/gu;
// Длинные числа (артикулы, штрихкоды)
const LONG_NUMBER = /(^|[^\p{L}\p{N}])\d{4,}(?![\p{L}\p{N}])/gu;

function basic(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Молоко «Савушкин» 3,2% 0.9л №1" → "молоко савушкин". Пустой результат — запасной вариант без вычистки чисел. */
export function normalizeName(input: string): string {
  let s = input.toLowerCase().replace(/ё/g, "е");
  s = s.replace(/[«»"'„“”‘’`]/g, " ");
  s = s.replace(NUMBER_SIGN, " ");
  s = s.replace(QTY_UNIT, "$1 ");
  s = s.replace(PERCENT, "$1 ");
  s = s.replace(MULTIPLIER, "$1 ");
  s = s.replace(LONG_NUMBER, "$1 ");
  s = basic(s);
  // Хвостовые голые числа (счётчики, остатки размеров)
  s = s.replace(/(?:\s\d+)+$/, "").trim();
  return s || basic(input);
}

/** Лицевой счёт / номер договора ЕРИП: только буквы и цифры, верхний регистр. */
export function normalizeAccount(input: string): string {
  return input.replace(/[^\p{L}\p{N}]+/gu, "").toUpperCase();
}
