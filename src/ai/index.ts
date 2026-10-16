// Точка входа распознавания: Gemini → (при сбое) Workers AI.

import { GeminiParser } from "./gemini";
import type { ParseContext, ParseErrorKind, ParseResult, ReceiptFile, ReceiptParser } from "./types";
import { WorkersAiParser } from "./workers-ai";

export type * from "./types";
export { GeminiParser } from "./gemini";
export { WorkersAiParser } from "./workers-ai";
export { buildPrompt } from "./prompt";
export { parseAiJson } from "./schema";

/** Ошибки основного движка, при которых пробуем запасной. */
const FALLBACK_ON: ReadonlySet<ParseErrorKind> = new Set(["rate_limited", "timeout", "upstream", "invalid_response"]);

/**
 * Пробует движки по очереди. Успех (в том числе not_purchase) — сразу возвращается.
 * Если запасной движок не поддерживает формат (PDF) — возвращается ошибка основного.
 * Если упали оба — ошибка запасного, в message — обе причины.
 */
export class FallbackParser implements ReceiptParser {
  readonly name: string;

  constructor(
    private readonly primary: ReceiptParser,
    private readonly secondary: ReceiptParser,
  ) {
    this.name = `${primary.name}+${secondary.name}`;
  }

  async parse(files: ReceiptFile[], ctx: ParseContext, signal?: AbortSignal): Promise<ParseResult> {
    const first = await this.primary.parse(files, ctx, signal);
    if (first.ok || !FALLBACK_ON.has(first.error) || signal?.aborted) return first;

    const second = await this.secondary.parse(files, ctx, signal);
    if (second.ok) return second;
    if (second.error === "unsupported") return first;
    return {
      ...second,
      message: `${first.model}: ${first.message}; ${second.model}: ${second.message}`,
      raw: second.raw ?? first.raw,
    };
  }
}

/**
 * Парсер для продакшена: Gemini (45 с) → Workers AI (30 с), худший случай ~75 с.
 * Таймауты щедрые: consumer очереди живёт до 15 мин, а Gemini под нагрузкой отвечает 15–30 с.
 * result.model — имя движка, который дал результат.
 */
export function createParser(env: Env): ReceiptParser {
  const gemini = new GeminiParser({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, timeoutMs: 45_000 });
  const workersAi = new WorkersAiParser({ ai: env.AI, model: env.WORKERS_AI_MODEL, timeoutMs: 30_000 });
  return new FallbackParser(gemini, workersAi);
}
