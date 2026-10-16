import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createParser, FallbackParser } from "./index";
import type { AiReceipt, ParseContext, ParseResult, ReceiptParser } from "./types";

const ctx: ParseContext = { categories: [{ code: "other", name: "Другое", description: null }], currency: "BYN", timezone: "Europe/Minsk", now: new Date() };
const files = [{ data: new ArrayBuffer(1), mime: "image/jpeg" }];
const receipt: AiReceipt = {
  doc_type: "store_receipt",
  store_name: null,
  purchased_at: null,
  currency: null,
  total_amount: 1,
  fee_amount: 0,
  erip_account: null,
  items: [],
  confidence: "high",
  reason: null,
};

const stub = (name: string, result: Omit<ParseResult, "model">): ReceiptParser & { parse: ReturnType<typeof vi.fn> } => ({
  name,
  parse: vi.fn(async () => ({ ...result, model: name }) as ParseResult),
});
const ok = { ok: true, receipt, raw: "{}" } as const;
const err = (error: "rate_limited" | "timeout" | "upstream" | "invalid_response" | "unsupported") =>
  ({ ok: false, error, message: error }) as const;

describe("FallbackParser", () => {
  it("успех основного — запасной не вызывается", async () => {
    const a = stub("gemini", ok);
    const b = stub("wai", ok);
    expect(await new FallbackParser(a, b).parse(files, ctx)).toMatchObject({ ok: true, model: "gemini" });
    expect(b.parse).not.toHaveBeenCalled();
  });

  it.each(["rate_limited", "timeout", "upstream", "invalid_response"] as const)("%s → запасной", async (kind) => {
    const r = await new FallbackParser(stub("gemini", err(kind)), stub("wai", ok)).parse(files, ctx);
    expect(r).toMatchObject({ ok: true, model: "wai" });
  });

  it("unsupported у основного — без fallback", async () => {
    const b = stub("wai", ok);
    expect(await new FallbackParser(stub("gemini", err("unsupported")), b).parse(files, ctx)).toMatchObject({ error: "unsupported" });
    expect(b.parse).not.toHaveBeenCalled();
  });

  it("запасной не умеет формат (PDF) — ошибка основного", async () => {
    const r = await new FallbackParser(stub("gemini", err("rate_limited")), stub("wai", err("unsupported"))).parse(files, ctx);
    expect(r).toMatchObject({ ok: false, error: "rate_limited", model: "gemini" });
  });

  it("упали оба — ошибка запасного с обеими причинами", async () => {
    const r = await new FallbackParser(stub("gemini", err("timeout")), stub("wai", err("invalid_response"))).parse(files, ctx);
    expect(r).toMatchObject({ ok: false, error: "invalid_response", model: "wai" });
    expect(!r.ok && r.message).toContain("gemini: timeout");
  });
});

describe("createParser", () => {
  it("собирает Gemini + Workers AI из env", () => {
    expect(createParser(env).name).toBe(`${env.GEMINI_MODEL}+${env.WORKERS_AI_MODEL}`);
  });
});
