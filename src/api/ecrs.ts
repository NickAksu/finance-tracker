import type { Hono } from "hono";
import { z } from "zod";
import { claimEcrsJob, enqueueEcrsJob, finishEcrsJob } from "../db/ecrs";
import { settleEcrsJob } from "../jobs/ecrs-publish";
import type { ApiEnv } from "./index";

const UID_RE = /^[0-9A-Fa-f]{24}$/;
const HTML_MAX = 500_000;

const enqueueSchema = z.object({ uid: z.string().regex(UID_RE) });
const resultSchema = z.object({
  id: z.number().int().positive(),
  ok: z.boolean(),
  html: z.string().max(HTML_MAX).optional(),
  error: z.string().max(500).optional(),
});

/** Секрет телефона. Пустой секрет никого не пускает. */
export function bearerOk(header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  const token = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim())?.[1] ?? "";
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(secret);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** Очередь для домашнего телефона. Регистрировать до авторизации Mini App. */
export function registerEcrs(api: Hono<ApiEnv>): void {
  api.use("/ecrs/*", async (c, next) => {
    if (!bearerOk(c.req.header("Authorization"), c.env.ECRS_FETCH_SECRET)) return unauthorized();
    await next();
  });

  api.post("/ecrs/jobs", async (c) => {
    const parsed = enqueueSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const job = await enqueueEcrsJob(c.env.DB, parsed.data.uid.toUpperCase());
    return Response.json(job, { status: job.created ? 201 : 200 });
  });

  api.get("/ecrs/next", async (c) => {
    const job = await claimEcrsJob(c.env.DB);
    if (!job) return new Response(null, { status: 204 });
    return Response.json(job);
  });

  api.post("/ecrs/result", async (c) => {
    const parsed = resultSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const body = parsed.data;
    const saved = body.ok
      ? body.html
        ? await finishEcrsJob(c.env.DB, body.id, { ok: true, html: body.html })
        : null
      : await finishEcrsJob(c.env.DB, body.id, { ok: false, error: body.error || "не скачалось" });
    if (saved === null) return Response.json({ error: "bad_request" }, { status: 400 });
    if (!saved) return Response.json({ error: "not_found" }, { status: 404 });
    await settleEcrsJob(c.env, body.id).catch((error) => console.error("ecrs settle", error));
    return new Response(null, { status: 204 });
  });
}
