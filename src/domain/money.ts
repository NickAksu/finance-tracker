// Деньги: храним целые минорные единицы (копейки), на входе — рубли от ИИ.

const NBSP = " ";

/** Рубли → копейки. Округление половины от нуля, устойчиво к шуму float (1.005, 12.345000001). */
export function toMinor(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  const abs = Math.abs(amount) * 100;
  // toFixed(6) срезает хвосты вида 100.49999999999999 → 100.5
  const rounded = Math.round(Number(abs.toFixed(6)));
  return amount < 0 ? -rounded : rounded;
}

/** Копейки → рубли (для отображения и сравнений). */
export function fromMinor(minor: number): number {
  return minor / 100;
}

/** 123456 → "1 234,56 BYN" (разделители — неразрывные пробелы, чтобы Telegram не переносил). */
export function formatMoney(minor: number, currency: string): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}${whole},${frac}${currency ? NBSP + currency : ""}`;
}

/**
 * Разбор суммы из строки: "12,50", "1 234.56", "12.50 BYN", "-3,00 р." → число; иначе null.
 * Понимает и "1.234,56" / "1,234.56" (последний разделитель — десятичный).
 */
export function parseDecimal(input: string): number | null {
  let s = input.trim().replace(/[\s  ']/g, "");
  // Валюта/единицы по краям: BYN, руб., р., $, €
  s = s.replace(/^(BYN|BYR|RUB|USD|EUR|руб\.?|р\.?|\$|€)/i, "").replace(/(BYN|BYR|RUB|USD|EUR|руб\.?|р\.?|\$|€)$/i, "");
  s = s.replace(/^−/, "-");
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (lastSep >= 0) {
    const intPart = s.slice(0, lastSep).replace(/[.,]/g, "");
    const fracPart = s.slice(lastSep + 1);
    // "1,234" / "1.234" с тремя цифрами после единственного разделителя — всё равно считаем десятичной дробью:
    // на чеках BY тысячи разделяют пробелом, а 3 знака после запятой бывают у веса (0,532).
    s = `${intPart}.${fracPart}`;
  }
  if (!/^-?\d*\.?\d+$/.test(s) && !/^-?\d+\.?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
