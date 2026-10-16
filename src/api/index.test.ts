import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { meResponseSchema } from "../../shared/api";
import { signInitData } from "../../test/helpers/init-data";
import { createApi } from "./index";

const OWNER_ID = 861165606; // в ALLOWED_USER_IDS и в семье
const ALLOWED_NOT_MEMBER_ID = 470022139; // в ALLOWED_USER_IDS, но в семье нет
const STRANGER_ID = 111222333; // не в ALLOWED_USER_IDS

const app = new Hono<{ Bindings: Env }>().route("/api", createApi());

async function call(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers }, env);
}

async function tmaHeader(userId: number, firstName = "Тест") {
  const initData = await signInitData(env.TELEGRAM_BOT_TOKEN, { user: { id: userId, first_name: firstName } });
  return { Authorization: `tma ${initData}` };
}

beforeAll(async () => {
  const createdAt = "2026-01-01T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO households (id, name, timezone, currency, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(901, "Семья Тест", "Europe/Minsk", "BYN", createdAt),
    env.DB.prepare(
      "INSERT INTO members (telegram_id, household_id, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(OWNER_ID, 901, "Николай", "owner", createdAt),
    env.DB.prepare(
      "INSERT INTO members (telegram_id, household_id, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(555000111, 901, "Катя", "member", "2026-01-02T00:00:00.000Z"),
  ]);
});

describe("API /api", () => {
  it("GET /api/health работает без авторизации", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /api/me возвращает участника, семью и состав", async () => {
    const res = await call("/api/me", await tmaHeader(OWNER_ID, "Николай"));
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(await res.json());
    expect(body).toEqual({
      member: { telegramId: OWNER_ID, displayName: "Николай", role: "owner" },
      household: { id: 901, name: "Семья Тест", timezone: "Europe/Minsk", currency: "BYN" },
      members: [
        { telegramId: OWNER_ID, displayName: "Николай", role: "owner" },
        { telegramId: 555000111, displayName: "Катя", role: "member" },
      ],
    });
  });

  it("401 без заголовка Authorization", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("401 при неверной подписи", async () => {
    const initData = await signInitData("999:OTHER_TOKEN", { user: { id: OWNER_ID, first_name: "X" } });
    const res = await call("/api/me", { Authorization: `tma ${initData}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_init_data" });
  });

  it("401 при другой схеме авторизации", async () => {
    const res = await call("/api/me", { Authorization: "Bearer abc" });
    expect(res.status).toBe(401);
  });

  it("403 для пользователя не из ALLOWED_USER_IDS", async () => {
    const res = await call("/api/me", await tmaHeader(STRANGER_ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("403 not_member для разрешённого пользователя вне семьи", async () => {
    const res = await call("/api/me", await tmaHeader(ALLOWED_NOT_MEMBER_ID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });

  it("404 JSON для неизвестного пути под /api", async () => {
    const res = await call("/api/nope", await tmaHeader(OWNER_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
