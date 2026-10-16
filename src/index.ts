import { webhookCallback, type Bot } from "grammy";
import { Hono } from "hono";
import { createApi } from "./api";
import type { BotContext } from "./bot/context";
import { createBot } from "./bot";
import { cleanupServiceTables } from "./db/updates";
import { handleReceiptJob } from "./jobs/receipt-job";
import type { ReceiptJob } from "./jobs/types";

let bot: Bot<BotContext> | undefined;

const app = new Hono<{ Bindings: Env }>();

// Telegram → бот. Адаптер сам сверяет X-Telegram-Bot-Api-Secret-Token.
app.post("/webhook", (c) => {
  bot ??= createBot(c.env);
  return webhookCallback(bot, "cloudflare-mod", { secretToken: c.env.WEBHOOK_SECRET })(c.req.raw);
});

app.route("/api", createApi());

// Остальное — статика Mini App (сюда попадают только пути из run_worker_first)
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  // Распознавание чеков: у consumer'а 15 минут вместо 30 секунд waitUntil
  async queue(batch, env) {
    for (const message of batch.messages) {
      await handleReceiptJob(env, message.body);
      message.ack();
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupServiceTables(env.DB));
  },
} satisfies ExportedHandler<Env, ReceiptJob>;
