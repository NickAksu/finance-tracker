import { describe, expect, it, vi } from "vitest";
import { GeminiParser } from "./gemini";
import type { ParseContext } from "./types";

const ctx: ParseContext = {
  categories: [
    { code: "groceries", name: "Продукты", description: null },
    { code: "other", name: "Другое", description: null },
  ],
  currency: "BYN",
  timezone: "Europe/Minsk",
  now: new Date("2026-10-08T12:00:00Z"),
};
const files = [{ data: new TextEncoder().encode("fake-jpeg").buffer as ArrayBuffer, mime: "image/jpeg" }];

const receiptJson = JSON.stringify({
  doc_type: "store_receipt",
  store_name: "Евроопт",
  purchased_at: "2026-10-05T14:32",
  currency: "BYN",
  erip_account: null,
  items: [{ name: "Хлеб", quantity: 1, price: 1.99, discount: 0, line_total: 1.99, category: "groceries" }],
  fee_amount: 0,
  total_amount: 1.99,
  confidence: "high",
  reason: null,
});

const okBody = (text: string, finishReason = "STOP") =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });

function parserWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 25_000) {
  const fetchMock = vi.fn(fetchImpl);
  const parser = new GeminiParser({ apiKey: "k", model: "gemini-3.8-flash", fetch: fetchMock as never, timeoutMs });
  return { parser, fetchMock };
}

describe("GeminiParser", () => {
  it("успешный ответ: запрос по контракту и разбор", async () => {
    const { parser, fetchMock } = parserWith(async () => new Response(okBody(receiptJson)));
    const r = await parser.parse(files, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe("gemini-3.8-flash");
    expect(r.receipt.total_amount).toBe(1.99);
    expect(r.receipt.items[0]?.category).toBe("groceries");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[0].inline_data).toEqual({ mime_type: "image/jpeg", data: btoa("fake-jpeg") });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.properties.items.items.properties.category.enum).toEqual(["groceries", "other"]);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(body.generationConfig.temperature).toBeUndefined();
  });

  it("429 → rate_limited", async () => {
    const { parser } = parserWith(
      async () =>
        new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }), { status: 429 }),
    );
    const r = await parser.parse(files, ctx);
    expect(r).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("503 → один повтор, затем upstream", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "high demand" } }), { status: 503 }));
    const parser = new GeminiParser({ apiKey: "k", model: "gemini-3.8-flash", fetch: fetchMock as never, retryDelayMs: 1 });
    expect(await parser.parse(files, ctx)).toMatchObject({ ok: false, error: "upstream" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("503, потом успех", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(okBody(receiptJson)));
    const parser = new GeminiParser({ apiKey: "k", model: "gemini-3.8-flash", fetch: fetchMock as never, retryDelayMs: 1 });
    expect(await parser.parse(files, ctx)).toMatchObject({ ok: true });
  });

  it("400 → upstream без повтора", async () => {
    const { parser, fetchMock } = parserWith(async () => new Response("bad", { status: 400 }));
    expect(await parser.parse(files, ctx)).toMatchObject({ ok: false, error: "upstream" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("невалидный JSON → invalid_response с raw", async () => {
    const { parser } = parserWith(async () => new Response(okBody("{ не json")));
    const r = await parser.parse(files, ctx);
    expect(r).toMatchObject({ ok: false, error: "invalid_response", raw: "{ не json" });
  });

  it("safety-блок и пустые кандидаты → invalid_response", async () => {
    const blocked = parserWith(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })));
    expect(await blocked.parser.parse(files, ctx)).toMatchObject({ ok: false, error: "invalid_response" });
    const empty = parserWith(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })));
    expect(await empty.parser.parse(files, ctx)).toMatchObject({ ok: false, error: "invalid_response" });
    const cut = parserWith(async () => new Response(okBody('{"doc_type":', "MAX_TOKENS")));
    expect(await cut.parser.parse(files, ctx)).toMatchObject({ ok: false, error: "invalid_response" });
  });

  it("таймаут → timeout", async () => {
    const { parser } = parserWith(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
      30,
    );
    expect(await parser.parse(files, ctx)).toMatchObject({ ok: false, error: "timeout" });
  });

  it("внешний signal прерывает запрос", async () => {
    const { parser } = parserWith(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const ac = new AbortController();
    const p = parser.parse(files, ctx, ac.signal);
    ac.abort();
    expect(await p).toMatchObject({ ok: false, error: "timeout" });
  });

  it("неподдерживаемый формат", async () => {
    const { parser, fetchMock } = parserWith(async () => new Response(""));
    expect(await parser.parse([{ data: new ArrayBuffer(1), mime: "image/gif" }], ctx)).toMatchObject({ error: "unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["gemini-3.8-flash", "gemini-flash-latest"])("%s → thinkingLevel, температура по умолчанию", async (model) => {
    const fetchMock = vi.fn(async () => new Response(okBody(receiptJson)));
    const parser = new GeminiParser({ apiKey: "k", model, fetch: fetchMock as never });
    await parser.parse(files, ctx);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(body.generationConfig.temperature).toBeUndefined();
  });

  it("gemini-2.5-flash → thinkingBudget и temperature 0", async () => {
    const fetchMock = vi.fn(async () => new Response(okBody(receiptJson)));
    const parser = new GeminiParser({ apiKey: "k", model: "gemini-2.5-flash", fetch: fetchMock as never });
    await parser.parse(files, ctx);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024 });
    expect(body.generationConfig.temperature).toBe(0);
  });
});
