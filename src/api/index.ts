// HTTP API Mini App. Монтируется основным приложением: `app.route("/api", createApi())`.
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorCode, Household, MeResponse, Member } from "../../shared/api";
import { getMemberContext, listMembers } from "../db/members";
import { validateInitData, type TelegramWebAppUser, type ValidatedInitData } from "./auth";
import { registerEcrs } from "./ecrs";

export interface ApiVariables {
  /** Пользователь Telegram из проверенного initData. */
  tgUser: TelegramWebAppUser;
  initData: ValidatedInitData;
  member: Member;
  household: Household;
}

export type ApiEnv = { Bindings: Env; Variables: ApiVariables };

function apiError(code: ApiErrorCode, status: ContentfulStatusCode): Response {
  return Response.json({ error: code }, { status });
}

/** Разбирает `ALLOWED_USER_IDS` ("1,2,3"). Пустой список = никого не пускаем. */
export function parseAllowedUserIds(raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number),
  );
}

/**
 * Авторизация по `Authorization: tma <initData>`:
 * 401 — нет/невалидный initData; 403 `forbidden` — не в ALLOWED_USER_IDS; 403 `not_member` — не в семье.
 */
export const requireMember = createMiddleware<ApiEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = /^tma\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return apiError("unauthorized", 401);

  const result = await validateInitData(match[1], c.env.TELEGRAM_BOT_TOKEN);
  if (!result.ok) return apiError("invalid_init_data", 401);

  const { user } = result.data;
  if (!parseAllowedUserIds(c.env.ALLOWED_USER_IDS).has(user.id)) return apiError("forbidden", 403);

  const ctx = await getMemberContext(c.env.DB, user.id);
  if (!ctx) return apiError("not_member", 403);

  c.set("tgUser", user);
  c.set("initData", result.data);
  c.set("member", ctx.member);
  c.set("household", ctx.household);
  await next();
});

export function createApi(): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();

  api.onError((err) => {
    console.error("api error", err);
    return apiError("internal", 500);
  });

  // Без авторизации Mini App — регистрируется до middleware.
  api.get("/health", (c) => c.json({ ok: true }));
  registerEcrs(api);

  api.use("*", requireMember);

  api.get("/me", async (c) => {
    const household = c.get("household");
    const members = await listMembers(c.env.DB, household.id);
    const body: MeResponse = { member: c.get("member"), household, members };
    return c.json(body);
  });

  // Неизвестные пути под /api отвечают JSON, а не SPA-фолбэком.
  api.all("*", () => apiError("not_found", 404));

  return api;
}
