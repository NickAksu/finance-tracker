import type { NextFunction } from "grammy";
import { getMember } from "../db/members";
import { markUpdateProcessed } from "../db/updates";
import { allowedUserIds, type BotContext } from "./context";
import { NOT_ALLOWED_TEXT } from "./texts";

/**
 * Пускает дальше только разрешённых пользователей (ALLOWED_USER_IDS) и подгружает участника.
 * Чужим в личке — вежливый отказ, в группе — тишина. my_chat_member и служебные сообщения о миграции
 * обрабатываются раньше этого фильтра.
 */
export async function accessGuard(ctx: BotContext, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !allowedUserIds(ctx.env).has(userId)) {
    if (ctx.chat?.type === "private" && ctx.message) await ctx.reply(NOT_ALLOWED_TEXT);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: NOT_ALLOWED_TEXT, show_alert: true });
    return;
  }
  // Telegram повторяет апдейт, если не дождался 200
  if (!(await markUpdateProcessed(ctx.env.DB, ctx.update.update_id))) return;
  ctx.member = await getMember(ctx.env.DB, userId);
  await next();
}
