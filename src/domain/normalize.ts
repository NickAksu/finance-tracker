// Нормализация ответа ИИ: деньги → копейки, комиссия → в позицию, правила категорий, время → UTC, проверка суммы.

import type { AiReceipt, Confidence } from "../ai/types";
import { OTHER_CATEGORY_CODE } from "./categories";
import { toMinor } from "./money";
import { normalizeAccount, normalizeName } from "./names";

export interface CategoryRef {
  id: number;
  code: string;
}

export interface RuleRef {
  id: number;
  matchType: "item" | "store" | "erip_account";
  pattern: string;
  categoryId: number;
}

export interface NormalizedItem {
  position: number;
  name: string;
  quantity: number;
  totalMinor: number;
  discountMinor: number;
  categoryId: number;
  categorySource: "ai" | "rule";
  ruleId: number | null;
}

export interface NormalizedReceipt {
  docType: "store_receipt" | "erip" | "online_order";
  storeName: string | null;
  /** UTC ISO "YYYY-MM-DDTHH:mm:ss.sssZ" */
  purchasedAt: string;
  totalMinor: number;
  currency: string;
  eripAccount: string | null;
  hasSumMismatch: boolean;
  confidence: Confidence;
  items: NormalizedItem[];
  appliedRuleIds: number[];
}

export interface NormalizeOptions {
  categories: CategoryRef[];
  rules: RuleRef[];
  defaultCurrency: string;
  timezone: string;
  now: Date;
}

const DAY_MS = 86_400_000;

export function normalizeReceipt(ai: AiReceipt, opts: NormalizeOptions): NormalizedReceipt {
  if (ai.doc_type === "not_purchase") throw new Error("normalizeReceipt: not_purchase не нормализуется");
  if (opts.categories.length === 0) throw new Error("normalizeReceipt: пустой список категорий");

  const byCode = new Map(opts.categories.map((c) => [c.code, c.id]));
  const otherId = byCode.get(OTHER_CATEGORY_CODE) ?? opts.categories[0]!.id;

  // Индексы правил по нормализованному ключу (первое правило с ключом выигрывает)
  const itemRules = new Map<string, RuleRef>();
  const storeRules = new Map<string, RuleRef>();
  const accountRules = new Map<string, RuleRef>();
  for (const r of opts.rules) {
    const map = r.matchType === "item" ? itemRules : r.matchType === "store" ? storeRules : accountRules;
    const key = r.matchType === "erip_account" ? normalizeAccount(r.pattern) : normalizeName(r.pattern);
    if (key && !map.has(key)) map.set(key, r);
  }

  const storeName = ai.store_name?.trim() || null;
  const eripAccount = ai.erip_account?.trim() || null;
  const accountRule = eripAccount ? accountRules.get(normalizeAccount(eripAccount)) : undefined;
  const storeRule = storeName ? storeRules.get(normalizeName(storeName)) : undefined;

  const resolve = (name: string, aiCode: string): Pick<NormalizedItem, "categoryId" | "categorySource" | "ruleId"> => {
    const rule = accountRule ?? itemRules.get(normalizeName(name)) ?? storeRule;
    if (rule) return { categoryId: rule.categoryId, categorySource: "rule", ruleId: rule.id };
    return { categoryId: byCode.get(aiCode) ?? otherId, categorySource: "ai", ruleId: null };
  };

  const items: NormalizedItem[] = [];
  for (const it of ai.items) {
    const name = it.name.trim();
    if (!name) continue;
    const quantity = Number.isFinite(it.quantity) && it.quantity > 0 ? Math.round(it.quantity * 1000) / 1000 : 1;
    const discountMinor = toMinor(Math.abs(it.discount || 0));
    const totalMinor =
      it.line_total != null
        ? toMinor(it.line_total)
        : it.price != null
          ? toMinor(it.price * quantity) - discountMinor
          : 0;
    items.push({ position: 0, name, quantity, totalMinor, discountMinor, ...resolve(name, it.category) });
  }

  const feeMinor = toMinor(Math.abs(ai.fee_amount || 0));
  let totalMinor = ai.total_amount != null ? toMinor(ai.total_amount) : null;

  if (items.length === 0) {
    // Нет позиций (типично для ЕРИП): одна позиция на всю сумму
    const name = storeName ?? "Платёж";
    const fallbackCode = ai.items[0]?.category ?? OTHER_CATEGORY_CODE;
    items.push({
      position: 0,
      name,
      quantity: 1,
      totalMinor: totalMinor ?? feeMinor,
      discountMinor: 0,
      ...resolve(name, fallbackCode),
    });
  } else if (feeMinor > 0) {
    // Комиссия входит в самую крупную позицию (решение 8)
    let largest = items[0]!;
    for (const it of items) if (it.totalMinor > largest.totalMinor) largest = it;
    largest.totalMinor += feeMinor;
  }

  items.forEach((it, i) => (it.position = i + 1));
  const itemsSum = items.reduce((s, it) => s + it.totalMinor, 0);
  totalMinor ??= itemsSum;

  const diff = Math.abs(itemsSum - totalMinor);
  const hasSumMismatch = diff > 1 && diff > Math.abs(totalMinor) * 0.01;

  const appliedRuleIds = [...new Set(items.flatMap((it) => (it.ruleId != null ? [it.ruleId] : [])))];

  return {
    docType: ai.doc_type,
    storeName,
    purchasedAt: resolvePurchasedAt(ai.purchased_at, opts.timezone, opts.now),
    totalMinor,
    currency: normalizeCurrency(ai.currency, opts.defaultCurrency),
    eripAccount,
    hasSumMismatch,
    confidence: ai.confidence,
    items,
    appliedRuleIds,
  };
}

function normalizeCurrency(c: string | null, fallback: string): string {
  const s = c?.trim().toUpperCase();
  return s && /^[A-Z]{3}$/.test(s) ? s : fallback.toUpperCase();
}

/** Локальное время с чека → UTC ISO. Нет даты, мусор или будущее (> суток) → now. */
export function resolvePurchasedAt(local: string | null, timezone: string, now: Date): string {
  const parts = local ? parseLocalDateTime(local) : null;
  if (!parts) return now.toISOString();
  const utc = localToUtc(parts, timezone);
  if (!Number.isFinite(utc) || utc > now.getTime() + DAY_MS) return now.toISOString();
  return new Date(utc).toISOString();
}

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** "YYYY-MM-DD[THH:mm[:ss]]" или "DD.MM.YYYY[ HH:mm[:ss]]"; только дата → 12:00. */
export function parseLocalDateTime(input: string): LocalParts | null {
  const s = input.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  let y: number, mo: number, d: number;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const hasTime = m[4] !== undefined;
  const h = hasTime ? Number(m[4]) : 12;
  const mi = hasTime ? Number(m[5]) : 0;
  const sec = m[6] !== undefined ? Number(m[6]) : 0;
  if (y < 2000 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  // Проверка существования дня (31.02 и т. п.)
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, mo, d, h, mi, s: sec };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Смещение зоны (мс) в момент utcMs: local - utc. */
export function tzOffsetMs(utcMs: number, timezone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Локальное время в зоне → UTC мс (две итерации — корректно и около переходов DST). */
export function localToUtc(p: LocalParts, timezone: string): number {
  const naive = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  let utc = naive - tzOffsetMs(naive, timezone);
  const off2 = tzOffsetMs(utc, timezone);
  utc = naive - off2;
  return utc;
}
