import type { Context } from "grammy";
import type { Member } from "../db/members";

export interface BotFlavor {
  env: Env;
  /** Участник семьи, если отправитель в ней состоит. */
  member: Member | null;
}

export type BotContext = Context & BotFlavor;

export function allowedUserIds(env: Env): Set<number> {
  return new Set(
    env.ALLOWED_USER_IDS.split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  );
}

export function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}
