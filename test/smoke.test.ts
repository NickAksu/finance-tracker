import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("применяет миграции D1", async () => {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'receipts'").first<{ n: number }>();
  expect(row?.n).toBe(1);
});
