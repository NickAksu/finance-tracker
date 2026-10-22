import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

const app = new Hono<{ Bindings: Env }>().route("/api", createApi());
const AUTH = { Authorization: "Bearer test-ecrs-secret" };
const UID = "396DA58C6F9C99BF071931BD";

async function call(path: string, init: RequestInit = {}) {
  return app.request(path, init, env);
}

describe("очередь чеков ecrs", () => {
  it("без секрета не пускает", async () => {
    const res = await call("/api/ecrs/next");
    expect(res.status).toBe(401);
  });

  it("телефон забирает задачу и возвращает страницу", async () => {
    const created = await call("/api/ecrs/jobs", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ uid: UID.toLowerCase() }),
    });
    expect(created.status).toBe(201);
    const job = (await created.json()) as { id: number; created: boolean };
    expect(job.created).toBe(true);

    const again = await call("/api/ecrs/jobs", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ uid: UID }),
    });
    expect(again.status).toBe(200);

    const next = await call("/api/ecrs/next", { headers: AUTH });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ id: job.id, uid: UID });

    const empty = await call("/api/ecrs/next", { headers: AUTH });
    expect(empty.status).toBe(204);

    const saved = await call("/api/ecrs/result", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id, ok: true, html: "<table>молоко</table>" }),
    });
    expect(saved.status).toBe(204);

    const row = await env.DB.prepare("SELECT status, html FROM ecrs_jobs WHERE id = ?").bind(job.id).first<{
      status: string;
      html: string;
    }>();
    expect(row).toEqual({ status: "done", html: "<table>молоко</table>" });
  });

  it("ошибка скачивания помечает задачу неудачной", async () => {
    const created = await call("/api/ecrs/jobs", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ uid: "AAAAAAAAAAAAAAAAAAAAAAAA" }),
    });
    const job = (await created.json()) as { id: number };
    await call("/api/ecrs/next", { headers: AUTH });
    const res = await call("/api/ecrs/result", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id, ok: false, error: "таймаут" }),
    });
    expect(res.status).toBe(204);
    const status = await env.DB.prepare("SELECT status, error FROM ecrs_jobs WHERE id = ?").bind(job.id).first<{
      status: string;
      error: string;
    }>();
    expect(status).toEqual({ status: "failed", error: "таймаут" });
  });
});
