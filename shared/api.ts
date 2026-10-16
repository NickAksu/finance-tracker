// Общие zod-схемы и типы API Mini App: используются и Worker'ом, и фронтом (webapp).
import { z } from "zod";

export const memberRoleSchema = z.enum(["owner", "member"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberSchema = z.object({
  telegramId: z.number().int(),
  displayName: z.string(),
  role: memberRoleSchema,
});
export type Member = z.infer<typeof memberSchema>;

export const householdSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  timezone: z.string(),
  currency: z.string(),
});
export type Household = z.infer<typeof householdSchema>;

/** Ответ `GET /api/me`. */
export const meResponseSchema = z.object({
  member: memberSchema,
  household: householdSchema,
  members: z.array(memberSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Коды ошибок API (`{ error: code }`). */
export const apiErrorCodeSchema = z.enum([
  "unauthorized", // нет заголовка Authorization: tma …
  "invalid_init_data", // подпись не сошлась / протухший auth_date / битые поля
  "forbidden", // пользователь не в ALLOWED_USER_IDS
  "not_member", // пользователь не состоит в семье
  "not_found",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;
