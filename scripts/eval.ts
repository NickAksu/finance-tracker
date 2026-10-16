// Прогон распознавания по фикстурам:
//   npm run eval [-- --only <case>] [--dir <path>] [--write-expected [--force]] [--delay <ms>] [--timeout <ms>]
// Работает в Node (tsx), не в workerd. Ключ берётся из env или .dev.vars и никогда не печатается.
// Формат фикстур и эталонов — fixtures/README.md.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { GeminiParser } from "../src/ai/gemini";
import type { ParseContext, ReceiptFile } from "../src/ai/types";
import { DEFAULT_CATEGORIES } from "../src/domain/categories";
import { formatMoney, fromMinor, toMinor } from "../src/domain/money";
import { normalizeName } from "../src/domain/names";
import { normalizeReceipt, type NormalizedReceipt } from "../src/domain/normalize";

const ROOT = resolve(import.meta.dirname, "..");
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

interface Expected {
  doc_type: string;
  total?: number | null;
  store_name?: string | null;
  items?: { name: string; total: number; category?: string }[];
}

interface Case {
  name: string;
  files: string[];
}

// ---------- аргументы и конфиг ----------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = resolve(option("--dir") ?? join(ROOT, "fixtures/receipts"));
const only = option("--only");
const writeExpected = flag("--write-expected");
const delayMs = Number(option("--delay") ?? 6000);
const timeoutMs = option("--timeout") ? Number(option("--timeout")) : undefined;

function readDevVars(): Record<string, string> {
  const path = join(ROOT, ".dev.vars");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function modelFromWrangler(): string | undefined {
  const path = join(ROOT, "wrangler.jsonc");
  if (!existsSync(path)) return undefined;
  return /"GEMINI_MODEL"\s*:\s*"([^"]+)"/.exec(readFileSync(path, "utf8"))?.[1];
}

const devVars = readDevVars();
const apiKey = process.env.GEMINI_API_KEY || devVars.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || devVars.GEMINI_MODEL || modelFromWrangler() || "gemini-3.8-flash";
if (!apiKey) {
  console.error("GEMINI_API_KEY не найден (env или .dev.vars)");
  process.exit(1);
}

// ---------- фикстуры ----------

/** order1_1.png + order1_2.png → один кейс "order1" (если частей ≥ 2); иначе кейс = имя файла без расширения. */
function collectCases(): Case[] {
  if (!existsSync(dir)) {
    console.error(`Нет папки ${dir}`);
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => MIME[extname(f).toLowerCase()]).sort();
  const groups = new Map<string, { n: number; file: string }[]>();
  for (const f of files) {
    const m = /^(.+)_(\d{1,2})\.[^.]+$/.exec(f);
    if (m) groups.set(m[1]!, [...(groups.get(m[1]!) ?? []), { n: Number(m[2]), file: f }]);
  }
  const cases: Case[] = [];
  const used = new Set<string>();
  for (const [base, parts] of groups) {
    if (parts.length < 2) continue;
    parts.sort((a, b) => a.n - b.n);
    cases.push({ name: base, files: parts.map((p) => p.file) });
    parts.forEach((p) => used.add(p.file));
  }
  for (const f of files) if (!used.has(f)) cases.push({ name: f.slice(0, -extname(f).length), files: [f] });
  return cases.sort((a, b) => a.name.localeCompare(b.name)).filter((c) => !only || c.name === only);
}

// ---------- сравнение ----------

function bigrams(s: string): string[] {
  const t = ` ${s} `;
  return Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2));
}

/** Сходство названий (коэффициент Дайса по биграммам нормализованных строк), 0..1. */
function similarity(a: string, b: string): number {
  const x = bigrams(normalizeName(a));
  const y = bigrams(normalizeName(b));
  if (!x.length || !y.length) return 0;
  const pool = new Map<string, number>();
  for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of x) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

interface CaseMetrics {
  docTypeOk: boolean;
  totalOk: boolean | null;
  itemsExpected: number;
  itemsMatched: number;
  itemsExtra: number;
  categoriesOk: number;
  categoriesChecked: number;
}

function compare(exp: Expected, docType: string, norm: NormalizedReceipt | null, codeById: Map<number, string>): CaseMetrics {
  const m: CaseMetrics = {
    docTypeOk: exp.doc_type === docType,
    totalOk: null,
    itemsExpected: exp.items?.length ?? 0,
    itemsMatched: 0,
    itemsExtra: 0,
    categoriesOk: 0,
    categoriesChecked: 0,
  };
  if (exp.total != null) m.totalOk = norm?.totalMinor === toMinor(exp.total);
  if (!exp.items || !norm) return m;

  const free = new Set(norm.items.map((_, i) => i));
  for (const e of exp.items) {
    const eMinor = toMinor(e.total);
    let best = -1;
    let bestScore = 0.35; // порог похожести названия
    for (const i of free) {
      const a = norm.items[i]!;
      if (Math.abs(a.totalMinor - eMinor) > 1) continue;
      const score = similarity(e.name, a.name);
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    if (best < 0) {
      console.log(`    ✗ не найдено: ${e.name} — ${e.total}`);
      continue;
    }
    free.delete(best);
    m.itemsMatched++;
    if (e.category) {
      m.categoriesChecked++;
      const got = codeById.get(norm.items[best]!.categoryId);
      if (got === e.category) m.categoriesOk++;
      else console.log(`    ~ категория «${e.name}»: ожидалось ${e.category}, получено ${got}`);
    }
  }
  m.itemsExtra = free.size;
  for (const i of free) console.log(`    + лишняя позиция: ${norm.items[i]!.name} — ${fromMinor(norm.items[i]!.totalMinor)}`);
  return m;
}

// ---------- прогон ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cases = collectCases();
  if (!cases.length) {
    console.log(`В ${dir} нет файлов${only ? ` для кейса ${only}` : ""}. См. fixtures/README.md`);
    return;
  }
  const parser = new GeminiParser({ apiKey: apiKey!, model, ...(timeoutMs ? { timeoutMs } : {}) });
  const categories = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, code: c.code }));
  const codeById = new Map(categories.map((c) => [c.id, c.code]));
  const now = new Date();
  const ctx: ParseContext = {
    categories: DEFAULT_CATEGORIES.map((c) => ({ code: c.code, name: c.name, description: c.description })),
    currency: "BYN",
    timezone: "Europe/Minsk",
    now,
  };

  console.log(`Модель: ${model}; кейсов: ${cases.length}; папка: ${dir}\n`);
  const byType = new Map<string, CaseMetrics[]>();

  for (const [idx, c] of cases.entries()) {
    if (idx > 0) await sleep(delayMs);
    const files: ReceiptFile[] = c.files.map((f) => {
      const buf = readFileSync(join(dir, f));
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, mime: MIME[extname(f).toLowerCase()]! };
    });
    const started = Date.now();
    const result = await parser.parse(files, ctx);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`■ ${c.name} (${c.files.join(", ")}) — ${secs} с`);

    if (!result.ok) {
      console.log(`  ОШИБКА ${result.error}: ${result.message}`);
      if (result.raw) console.log(`  raw: ${result.raw.slice(0, 500)}`);
      // Ошибка распознавания засчитывается как промах по всем метрикам
      const expPath = join(dir, `${c.name}.expected.json`);
      if (!writeExpected && existsSync(expPath)) {
        const exp = JSON.parse(readFileSync(expPath, "utf8")) as Expected;
        byType.set(exp.doc_type, [...(byType.get(exp.doc_type) ?? []), compare(exp, "error", null, codeById)]);
      }
      console.log();
      continue;
    }
    const ai = result.receipt;
    const norm =
      ai.doc_type === "not_purchase"
        ? null
        : normalizeReceipt(ai, { categories, rules: [], defaultCurrency: "BYN", timezone: ctx.timezone, now });

    console.log(`  тип: ${ai.doc_type}; уверенность: ${ai.confidence}${ai.reason ? `; причина: ${ai.reason}` : ""}`);
    if (norm) {
      console.log(
        `  ${norm.storeName ?? "—"} · ${ai.purchased_at ?? "без даты"} · итог ${formatMoney(norm.totalMinor, norm.currency)}` +
          `${ai.fee_amount ? ` (комиссия ${ai.fee_amount})` : ""}${norm.eripAccount ? ` · л/с ${norm.eripAccount}` : ""}` +
          `${norm.hasSumMismatch ? " · ⚠️ сумма позиций не сходится" : ""}`,
      );
      for (const it of norm.items) {
        console.log(
          `    ${it.position}. ${it.name} × ${it.quantity} = ${fromMinor(it.totalMinor)}` +
            `${it.discountMinor ? ` (скидка ${fromMinor(it.discountMinor)})` : ""} [${codeById.get(it.categoryId)}]`,
        );
      }
    }

    const expPath = join(dir, `${c.name}.expected.json`);
    if (writeExpected) {
      const exp: Expected = {
        doc_type: ai.doc_type,
        total: norm ? fromMinor(norm.totalMinor) : null,
        store_name: norm?.storeName ?? null,
        items: norm?.items.map((it) => ({ name: it.name, total: fromMinor(it.totalMinor), category: codeById.get(it.categoryId)! })) ?? [],
      };
      if (existsSync(expPath) && !flag("--force")) console.log(`  эталон уже есть, не перезаписываю (--force): ${expPath}`);
      else {
        writeFileSync(expPath, JSON.stringify(exp, null, 2) + "\n");
        console.log(`  записан эталон: ${expPath} — проверьте и поправьте вручную`);
      }
    } else if (existsSync(expPath)) {
      const exp = JSON.parse(readFileSync(expPath, "utf8")) as Expected;
      const m = compare(exp, ai.doc_type, norm, codeById);
      if (exp.store_name && norm?.storeName && normalizeName(exp.store_name) !== normalizeName(norm.storeName)) {
        console.log(`    ~ магазин: ожидалось «${exp.store_name}», получено «${norm.storeName}»`);
      }
      console.log(
        `  сравнение: тип ${m.docTypeOk ? "✓" : `✗ (ожидался ${exp.doc_type})`}; итог ${m.totalOk == null ? "—" : m.totalOk ? "✓" : `✗ (ожидался ${exp.total})`}` +
          (exp.items ? `; позиции ${m.itemsMatched}/${m.itemsExpected} (+${m.itemsExtra} лишних); категории ${m.categoriesOk}/${m.categoriesChecked}` : ""),
      );
      byType.set(exp.doc_type, [...(byType.get(exp.doc_type) ?? []), m]);
    }
    console.log();
  }

  if (byType.size) {
    console.log("Итоги по типам документов:");
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}% (${a}/${b})` : "—");
    const all: CaseMetrics[] = [];
    const report = (label: string, ms: CaseMetrics[]) => {
      const totals = ms.filter((m) => m.totalOk != null);
      const sum = (f: (m: CaseMetrics) => number) => ms.reduce((s, m) => s + f(m), 0);
      console.log(
        `  ${label.padEnd(14)} кейсов ${ms.length}; тип ${pct(ms.filter((m) => m.docTypeOk).length, ms.length)}; ` +
          `итог ${pct(totals.filter((m) => m.totalOk).length, totals.length)}; ` +
          `позиции ${pct(sum((m) => m.itemsMatched), sum((m) => m.itemsExpected))}; ` +
          `категории ${pct(sum((m) => m.categoriesOk), sum((m) => m.categoriesChecked))}`,
      );
    };
    for (const [type, ms] of [...byType].sort()) {
      report(type, ms);
      all.push(...ms);
    }
    report("ВСЕГО", all);
  }
}

await main();
