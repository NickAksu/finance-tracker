import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, type NextFunction } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { accessGuard } from "./access";
import { commands } from "./commands";
import { isGroupChat, type BotContext } from "./context";
import { groups } from "./groups";
import { receipts } from "./receipts";

export function createBot(env: Env): Bot<BotContext> {
  const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN, { botInfo: env.BOT_INFO as UserFromGetMe });
  // В вебхуке долго ждать нельзя: Telegram повторит апдейт
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));

  bot.use((ctx, next) => {
    ctx.env = env;
    ctx.member = null;
    return next();
  });
  bot.use(relevantOnly);
  bot.use(groups);
  bot.use(accessGuard);
  bot.use(commands);
  bot.use(receipts);

  bot.on("message:text", async (ctx) => {
    if (isGroupChat(ctx)) return;
    await ctx.reply("Пришлите фото чека, скриншот или PDF — я его распознаю. Справка: /help");
  });

  bot.catch((err) => {
    console.error("bot error", err.ctx.update.update_id, err.error);
  });
  return bot;
}

/**
 * Privacy mode выключен, поэтому бот видит всю переписку в группе.
 * Обычные сообщения отбрасываем сразу, не тратя запросы к D1.
 */
async function relevantOnly(ctx: BotContext, next: NextFunction): Promise<void> {
  if (ctx.myChatMember || ctx.callbackQuery) return next();
  const m = ctx.message;
  if (!m) return; // edited_message и прочее нам не нужны
  if (!isGroupChat(ctx)) return next();
  if (m.photo || m.document || m.migrate_to_chat_id || m.migrate_from_chat_id || m.text?.startsWith("/")) return next();
}
