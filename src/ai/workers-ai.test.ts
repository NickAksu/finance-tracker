import { describe, expect, it, vi } from "vitest";
import type { ParseContext } from "./types";
import { WorkersAiParser } from "./workers-ai";

const ctx: ParseContext = {
  categories: [
    { code: "utilities", name: "Коммуналка", description: null },
    { code: "other", name: "Другое", description: null },
  ],
  currency: "BYN",
  timezone: "Europe/Minsk",
  now: new Date("2026-10-08T12:00:00Z"),
};
const img = { data: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, mime: "image/png" };
const answer = {
  doc_type: "erip",
  store_name: "ЖЭС",
  purchased_at: "2026-10-01T10:00",
  currency: "BYN",
  erip_account: "123",
  items: [{ name: "Отопление", quantity: 1, price: 50, discount: 0, line_total: 50, category: "utilities" }],
  fee_amount: 0.5,
  total_amount: 50.5,
  confidence: "high",
  reason: null,
};

describe("WorkersAiParser", () => {
  it("картинки как data URL, JSON mode, confidence не выше medium", async () => {
    const run = vi.fn(async () => ({ response: answer }));
    const parser = new WorkersAiParser({ ai: { run }, model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
    const r = await parser.parse([img, img], ctx);
    expect(r).toMatchObject({ ok: true, model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
    if (!r.ok) return;
    expect(r.receipt.total_amount).toBe(50.5);
    expect(r.receipt.confidence).toBe("medium");
    const inputs = (run.mock.calls[0] as unknown as [string, any])[1];
    const content = inputs.messages[0].content;
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } });
    expect(content).toHaveLength(3);
    expect(inputs.response_format.type).toBe("json_schema");
    expect(inputs.max_tokens).toBeGreaterThan(1000);
  });

  it("строковый ответ с обёрткой разбирается", async () => {
    const run = vi.fn(async () => ({ response: "```json\n" + JSON.stringify(answer) + "\n```" }));
    const r = await new WorkersAiParser({ ai: { run }, model: "m" }).parse([img], ctx);
    expect(r.ok).toBe(true);
  });

  it("ошибка JSON mode → повтор с одной картинкой без response_format, confidence low", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("AiError: JSON Mode couldn't be met"))
      .mockResolvedValueOnce({ response: JSON.stringify(answer) });
    const r = await new WorkersAiParser({ ai: { run }, model: "m" }).parse([img, img], ctx);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.receipt.confidence).toBe("low");
    const second = run.mock.calls[1]![1];
    expect(second.response_format).toBeUndefined();
    expect(second.messages[0].content).toHaveLength(2);
  });

  it("PDF → unsupported без вызова", async () => {
    const run = vi.fn();
    const r = await new WorkersAiParser({ ai: { run }, model: "m" }).parse([{ data: new ArrayBuffer(1), mime: "application/pdf" }], ctx);
    expect(r).toMatchObject({ ok: false, error: "unsupported" });
    expect(run).not.toHaveBeenCalled();
  });

  it("лимит нейронов → rate_limited", async () => {
    const run = vi.fn().mockRejectedValue(new Error("AiError: 3036: Account limit of 10000 daily neurons exceeded"));
    expect(await new WorkersAiParser({ ai: { run }, model: "m" }).parse([img], ctx)).toMatchObject({ error: "rate_limited" });
  });

  it("мусор в ответе → invalid_response", async () => {
    const run = vi.fn(async () => ({ response: "не могу прочитать" }));
    expect(await new WorkersAiParser({ ai: { run }, model: "m" }).parse([img], ctx)).toMatchObject({ error: "invalid_response" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("зависший вызов → timeout", async () => {
    const run = vi.fn(() => new Promise(() => {}));
    const r = await new WorkersAiParser({ ai: { run }, model: "m", timeoutMs: 30 }).parse([img], ctx);
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });
});
