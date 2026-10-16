import { Composer } from "grammy";
import { bindGroup, getChatLink, migrateChat, unlinkChat } from "../db/chats";
import { getMember } from "../db/members";
import { allowedUserIds, type BotContext } from "./context";

/**
 * Жизненный цикл групп. Регистрируется ДО фильтра доступа: бот должен выйти из группы,
 * куда его добавил посторонний, и отследить миграцию группы в супергруппу.
 */
export const groups = new Composer<BotContext>();

groups.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const status = ctx.myChatMember.new_chat_member.status;
  const db = ctx.env.DB;

  if (status === "left" || status === "kicked") {
    await unlinkChat(db, chat.id);
    return;
  }
  if (status !== "member" && status !== "administrator") return;
  const oldStatus = ctx.myChatMember.old_chat_member.status;
  if (oldStatus === "member" || oldStatus === "administrator") return; // смена прав, не добавление

  const adder = ctx.myChatMember.from;
  const member = allowedUserIds(ctx.env).has(adder.id) ? await getMember(db, adder.id) : null;
  if (!member) {
    console.warn("bot added to a group by a stranger, leaving", chat.id, adder.id);
    await ctx.api.leaveChat(chat.id).catch((e) => console.warn("leaveChat", e));
    return;
  }
  const previous = await bindGroup(db, {
    chatId: chat.id,
    householdId: member.householdId,
    type: chat.type,
    title: chat.title,
  });
  await ctx.reply(
    "👋 Привет! Это общий чат семьи: присылайте сюда фото чеков, скриншоты ЕРИП и онлайн-заказов.\n" +
      "Кто прислал чек — тот и заплатил. Справка: /help" +
      (previous ? "\n\nПрежний общий чат отвязан: в него больше не будут приходить отчёты." : ""),
  );
});

// Группа стала супергруппой: chat_id меняется. Сообщение приходит в оба чата — обработка идемпотентна.
groups.on("message:migrate_to_chat_id", async (ctx) => {
  await migrateChat(ctx.env.DB, ctx.chat.id, ctx.message.migrate_to_chat_id);
});
groups.on("message:migrate_from_chat_id", async (ctx) => {
  await migrateChat(ctx.env.DB, ctx.message.migrate_from_chat_id, ctx.chat.id);
});

/**
 * Для сообщений из группы: семья, к которой привязан чат. Непривязанную группу
 * привязываем к семье отправителя-участника (бота добавили до создания семьи).
 */
export async function groupHouseholdId(ctx: BotContext): Promise<number | null> {
  const chat = ctx.chat!;
  const link = await getChatLink(ctx.env.DB, chat.id);
  if (link) return link.householdId;
  if (!ctx.member || (chat.type !== "group" && chat.type !== "supergroup")) return null;
  await bindGroup(ctx.env.DB, { chatId: chat.id, householdId: ctx.member.householdId, type: chat.type, title: chat.title });
  return ctx.member.householdId;
}
