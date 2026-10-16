// Запасной движок: vision-модель Workers AI (по умолчанию Llama 4 Scout) через binding env.AI.
// Картинки — OpenAI-подобные сообщения с image_url (data URL). PDF не поддерживается.
// JSON mode у Llama 4 Scout официально не заявлен: пробуем response_format, при ошибке — повтор
// без него (и только с первой картинкой); ответ в любом случае разбираем снисходительно.

import { Buffer } from "node:buffer";
import { buildPrompt } from "./prompt";
import { jsonSchemaForReceipt, parseAiJson } from "./schema";
import type { Confidence, ParseContext, ParseErrorKind, ParseResult, ReceiptFile, ReceiptParser } from "./types";

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Llama 4 Scout принимает до 5 картинок за запрос. */
const MAX_IMAGES = 5;

/** Минимальный интерфейс binding'а — не завязываемся на типы конкретной модели. */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface WorkersAiParserOptions {
  ai: AiRunner | Ai;
  model: string;
  /** Таймаут одного вызова, мс (по умолчанию 20 000). */
  timeoutMs?: number;
}

const JSON_HINT = `
Output ONLY one JSON object, no markdown, with keys:
{"doc_type":"store_receipt|erip|online_order|not_purchase","store_name":string|null,"purchased_at":string|null,"currency":string|null,"erip_account":string|null,"items":[{"name":string,"quantity":number,"price":number|null,"discount":number,"line_total":number|null,"category":string}],"fee_amount":number,"total_amount":number|null,"confidence":"low|medium|high","reason":string|null}`;

export class WorkersAiParser implements ReceiptParser {
  readonly name: string;
  private readonly ai: AiRunner;
  private readonly timeoutMs: number;

  constructor(private readonly opts: WorkersAiParserOptions) {
    this.name = opts.model;
    this.ai = opts.ai as unknown as AiRunner;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async parse(files: ReceiptFile[], ctx: ParseContext, signal?: AbortSignal): Promise<ParseResult> {
    const model = this.opts.model;
    const fail = (error: ParseErrorKind, message: string, raw?: string): ParseResult => ({
      ok: false,
      error,
      message,
      model,
      ...(raw !== undefined ? { raw } : {}),
    });

    if (files.length === 0) return fail("unsupported", "нет файлов");
    const bad = files.find((f) => !IMAGE_MIME.has(f.mime));
    if (bad) return fail("unsupported", `${model} не принимает ${bad.mime}`);

    const codes = ctx.categories.map((c) => c.code);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

    // Попытка 1: все картинки (до 5) + JSON mode. Попытка 2 (если модель/режим отвергли запрос):
    // одна первая картинка без response_format.
    const attempts = [
      { images: files.slice(0, MAX_IMAGES), jsonMode: true },
      ...(files.length > 1 ? [{ images: files.slice(0, 1), jsonMode: false }] : [{ images: files, jsonMode: false }]),
    ];

    let lastError: ParseResult | null = null;
    for (const [i, attempt] of attempts.entries()) {
      if (combined.aborted) return fail("timeout", `нет ответа за ${this.timeoutMs} мс`);
      const content = [
        { type: "text", text: buildPrompt(ctx, attempt.images.length) + JSON_HINT },
        ...attempt.images.map((f) => ({
          type: "image_url",
          image_url: { url: `data:${f.mime};base64,${Buffer.from(f.data).toString("base64")}` },
        })),
      ];
      const inputs: Record<string, unknown> = {
        messages: [{ role: "user", content }],
        max_tokens: 4096,
        temperature: 0,
        ...(attempt.jsonMode ? { response_format: { type: "json_schema", json_schema: jsonSchemaForReceipt(codes) } } : {}),
      };

      let out: unknown;
      try {
        out = await raceAbort(this.ai.run(model, inputs, { signal: combined }), combined);
      } catch (e) {
        if (combined.aborted) return fail("timeout", `нет ответа за ${this.timeoutMs} мс`);
        const message = (e as Error)?.message ?? String(e);
        if (isRateLimit(message)) return fail("rate_limited", message);
        lastError = fail("upstream", message);
        continue; // пробуем упрощённый запрос
      }

      const response = (out as { response?: unknown } | null)?.response;
      const raw = typeof response === "string" ? response : JSON.stringify(response ?? null);
      const parsed =
        typeof response === "string"
          ? parseAiJson(response, codes)
          : response && typeof response === "object"
            ? parseAiJson(raw, codes)
            : ({ ok: false, error: "пустой ответ" } as const);
      if (!parsed.ok) {
        lastError = fail("invalid_response", parsed.error, raw);
        // Повтор имеет смысл, только если первая попытка была в JSON mode
        if (i === 0 && attempt.jsonMode) continue;
        return lastError;
      }

      const receipt = parsed.receipt;
      // Запасная модель слабее: не выше medium; обрезанный набор картинок — low
      const cap: Confidence = attempt.images.length < files.length ? "low" : "medium";
      if (rank(receipt.confidence) > rank(cap)) receipt.confidence = cap;
      return { ok: true, receipt, model, raw };
    }
    return lastError ?? fail("upstream", "нет ответа");
  }
}

function rank(c: Confidence): number {
  return c === "low" ? 0 : c === "medium" ? 1 : 2;
}

function isRateLimit(message: string): boolean {
  // 3036 — исчерпан дневной лимит нейронов, 3040 — нет мощностей, 429 — слишком часто
  return /\b(429|3036|3040)\b|rate.?limit|too many requests|daily free allocation|capacity/i.test(message);
}

/** Страховка: binding может не уважать signal — ограничиваем ожидание сами. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
