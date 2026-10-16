// Основной движок: Gemini (REST generateContent v1beta) со structured output.

import { Buffer } from "node:buffer";
import { buildPrompt } from "./prompt";
import { geminiResponseSchema, parseAiJson } from "./schema";
import type { ParseContext, ParseErrorKind, ParseResult, ReceiptFile, ReceiptParser } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
/** Лимит inline-запроса Gemini — 20 МБ; base64 раздувает на 4/3. */
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

export interface GeminiParserOptions {
  apiKey: string;
  /** Например, "gemini-3.8-flash". */
  model: string;
  /** Таймаут одного запроса, мс (по умолчанию 25 000). */
  timeoutMs?: number;
  /** Уровень «размышлений» для Gemini 3+ (по умолчанию "low": чек — OCR + арифметика, важна задержка). */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  /** Бюджет «размышлений» для моделей 2.x (токены; 0 — выключить, -1 — динамически; по умолчанию 1024). */
  thinkingBudget?: number;
  /** Пауза перед повтором при 503/500, мс (по умолчанию 1500). */
  retryDelayMs?: number;
  /** Подмена fetch (тесты, Node-скрипты). */
  fetch?: typeof fetch;
}

export class GeminiParser implements ReceiptParser {
  readonly name: string;
  private readonly timeoutMs: number;
  private readonly thinkingConfig: Record<string, unknown>;
  /** Модели 2.x: thinkingBudget и temperature 0. Gemini 3+: thinkingLevel, temperature по умолчанию (1.0 — так рекомендует Google). */
  private readonly legacy: boolean;
  private readonly retryDelayMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: GeminiParserOptions) {
    this.name = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    this.legacy = /^gemini-[12]\./.test(opts.model);
    this.thinkingConfig = this.legacy
      ? { thinkingBudget: opts.thinkingBudget ?? 1024 }
      : { thinkingLevel: opts.thinkingLevel ?? "low" };
    this.retryDelayMs = opts.retryDelayMs ?? 1500;
    // Без bind workerd ругается на «Illegal invocation»
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
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
    const bad = files.find((f) => !SUPPORTED_MIME.has(f.mime));
    if (bad) return fail("unsupported", `формат ${bad.mime} не поддерживается`);
    const size = files.reduce((s, f) => s + f.data.byteLength, 0);
    if (size > MAX_INLINE_BYTES) return fail("unsupported", `файлы слишком большие (${size} байт)`);

    const codes = ctx.categories.map((c) => c.code);
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            ...files.map((f) => ({ inline_data: { mime_type: f.mime, data: Buffer.from(f.data).toString("base64") } })),
            { text: buildPrompt(ctx, files.length) },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: geminiResponseSchema(codes),
        ...(this.legacy ? { temperature: 0 } : {}),
        maxOutputTokens: 16_384,
        thinkingConfig: this.thinkingConfig,
      },
    };

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const payload = JSON.stringify(body);
    const started = Date.now();
    let res: Response | undefined;
    let text = "";
    // 503 «high demand» у Gemini бывает часто и проходит за секунды: один быстрый повтор,
    // если прошло меньше трети таймаута, — дешевле, чем уходить на слабый запасной движок.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await this.fetchFn(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
          body: payload,
          signal: combined,
        });
        text = await res.text();
      } catch (e) {
        if (combined.aborted || isAbortError(e)) return fail("timeout", `нет ответа за ${this.timeoutMs} мс`);
        return fail("upstream", `сеть: ${(e as Error).message ?? String(e)}`);
      }
      const retriable = res.status === 503 || res.status === 500;
      if (!retriable || attempt > 0 || Date.now() - started > this.timeoutMs / 3) break;
      await sleep(this.retryDelayMs, combined);
      if (combined.aborted) return fail("timeout", `нет ответа за ${this.timeoutMs} мс`);
    }
    if (!res) return fail("upstream", "нет ответа");

    if (!res.ok) {
      const apiError = safeJson(text) as { error?: { status?: string; message?: string } } | null;
      const status = apiError?.error?.status;
      const message = `HTTP ${res.status}${status ? ` ${status}` : ""}: ${(apiError?.error?.message ?? text).slice(0, 300)}`;
      if (res.status === 429 || status === "RESOURCE_EXHAUSTED") return fail("rate_limited", message);
      if (res.status === 504 || status === "DEADLINE_EXCEEDED") return fail("timeout", message);
      return fail("upstream", message);
    }

    const data = safeJson(text) as GenerateContentResponse | null;
    if (!data) return fail("invalid_response", "ответ API не JSON", text.slice(0, 1000));
    if (data.promptFeedback?.blockReason) {
      return fail("invalid_response", `запрос заблокирован: ${data.promptFeedback.blockReason}`);
    }
    const cand = data.candidates?.[0];
    const out = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (!out) return fail("invalid_response", `пустой ответ (finishReason: ${cand?.finishReason ?? "нет кандидатов"})`);
    if (cand?.finishReason && cand.finishReason !== "STOP") {
      return fail("invalid_response", `ответ оборван: ${cand.finishReason}`, out);
    }

    const parsed = parseAiJson(out, codes);
    if (!parsed.ok) return fail("invalid_response", parsed.error, out);
    return { ok: true, receipt: parsed.receipt, model, raw: out };
  }
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}
