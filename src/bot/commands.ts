import { Composer } from "grammy";
import { bindGroup, linkPrivateChat } from "../db/chats";
import { createHousehold, deleteEmptyHousehold, getHousehold, isHouseholdDisposable } from "../db/households";
import { consumeInvite, createInvite } from "../db/invites";
import { addMember, getMember } from "../db/members";
import { escapeHtml } from "../telegram";
import { isGroupChat, type BotContext } from "./context";
import { HELP_TEXT, NEED_INVITE_TEXT } from "./texts";

export const commands = new Composer<BotContext>();

commands.command("start", async (ctx) => {
  if (isGroupChat(ctx)) return linkGroupFromCommand(ctx);
  const payload = ctx.match.trim();
  if (payload.startsWith("join_")) return joinByInvite(ctx, payload.slice("join_".length));

  const user = ctx.from!;
  if (ctx.member) {
    await linkPrivateChat(ctx.env.DB, ctx.chat.id, ctx.member.householdId);
    await ctx.reply(`С возвращением, ${escapeHtml(ctx.member.displayName)}! 👋\n\n${HELP_TEXT}`, { parse_mode: "HTML" });
    return;
  }

  // Первый запуск: создаём семью. Второй участник приходит по ссылке-приглашению.
  await createHousehold(ctx.env.DB, {
    ownerId: user.id,
    ownerName: user.first_name,
    timezone: ctx.env.DEFAULT_TZ,
    currency: ctx.env.DEFAULT_CURRENCY,
  });
  await ctx.reply(
    `Привет, ${escapeHtml(user.first_name)}! 👋 Я создал для вас семейный бюджет.\n\n` +
      `Чтобы добавить второго участника, отправьте /invite и перешлите ему ссылку.\n\n${HELP_TEXT}`,
    { parse_mode: "HTML" },
  );
});

async function joinByInvite(ctx: BotContext, code: string): Promise<void> {
  const user = ctx.from!;
  const db = ctx.env.DB;
  const current = ctx.member;
  // Участник случайно создал свою пустую семью раньше, чем открыл приглашение, — её можно бросить
  if (current && !(await isHouseholdDisposable(db, current.householdId))) {
    await ctx.reply("Вы уже состоите в семье. Выйти из неё пока можно только через владельца.");
    return;
  }
  const invite = await consumeInvite(db, code, user.id);
  if (!invite) {
    await ctx.reply(`Ссылка недействительна: она одноразовая и живёт 24 часа. ${NEED_INVITE_TEXT}`);
    return;
  }
  if (current?.householdId === invite.householdId) {
    await ctx.reply("Вы уже в этой семье 🙂");
    return;
  }
  if (current) await deleteEmptyHousehold(db, current.householdId);
  await addMember(db, { telegramId: user.id, householdId: invite.householdId, displayName: user.first_name });

  const household = await getHousehold(db, invite.householdId);
  await ctx.reply(`🎉 Вы присоединились к семье «${escapeHtml(household?.name ?? "Семья")}».\n\n${HELP_TEXT}`, {
    parse_mode: "HTML",
  });
  await ctx.api
    .sendMessage(invite.createdBy, `👋 ${escapeHtml(user.first_name)} теперь в семье.`, { parse_mode: "HTML" })
    .catch((e) => console.warn("notify inviter", e));
}

/** /start в группе: привязать её к семье того, кто написал. */
async function linkGroupFromCommand(ctx: BotContext): Promise<void> {
  if (!ctx.member) {
    await ctx.reply(`Сначала напишите мне в личку /start. ${NEED_INVITE_TEXT}`);
    return;
  }
  const chat = ctx.chat!;
  await bindGroup(ctx.env.DB, {
    chatId: chat.id,
    householdId: ctx.member.householdId,
    type: chat.type === "supergroup" ? "supergroup" : "group",
    title: "title" in chat ? (chat.title ?? null) : null,
  });
  await ctx.reply("✅ Этот чат — общий чат семьи. Присылайте сюда фото чеков.");
}

commands.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
});

commands.command("invite", async (ctx) => {
  if (!ctx.member) {
    await ctx.reply(NEED_INVITE_TEXT);
    return;
  }
  if (isGroupChat(ctx)) {
    await ctx.reply("Приглашение создаётся в личном чате со мной — отправьте /invite туда.");
    return;
  }
  const code = await createInvite(ctx.env.DB, ctx.member.householdId, ctx.member.telegramId);
  const link = `https://t.me/${ctx.me.username}?start=join_${code}`;
  await ctx.reply(
    `Ссылка-приглашение в семью (одноразовая, действует 24 часа):\n${link}\n\n` +
      "Перешлите её второму участнику: ему нужно открыть ссылку и нажать «Start».",
    { link_preview_options: { is_disabled: true } },
  );
});

/** Повторно проверяем членство: getMember на случай, если участник только что вступил. */
export async function requireMember(ctx: BotContext): Promise<boolean> {
  if (ctx.member) return true;
  ctx.member = await getMember(ctx.env.DB, ctx.from!.id);
  return ctx.member !== null;
}
