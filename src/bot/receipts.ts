import { Composer } from "grammy";
import type { Message } from "grammy/types";
import { getHousehold } from "../db/households";
import { addMediaGroupPart, setMediaGroupStatusMessage } from "../db/media-groups";
import { deleteReceipt, findReceiptByFiles, getReceipt, setReceiptStatus, type ReceiptFileRef, type ReceiptSource } from "../db/receipts";
import { formatMoney } from "../domain/money";
import { formatDate } from "../lib/time";
import { ALBUM_DELAY_SECONDS, type ReceiptJob } from "../jobs/types";
import { escapeHtml, isNotModified, MAX_DOWNLOAD_BYTES } from "../telegram";
import { isGroupChat, type BotContext } from "./context";
import { groupHouseholdId } from "./groups";
import { deleteConfirmKeyboard, receiptKeyboard, renderReceiptSummary } from "./summary";
import { NEED_INVITE_TEXT } from "./texts";

export const receipts = new Composer<BotContext>();

const SUPPORTED_DOCUMENT_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);

type Extracted = { file: ReceiptFileRef; source: ReceiptSource } | { error: string };

function extractFile(message: Message): Extracted | null {
  if (message.photo?.length) {
    // Самый крупный размер: Telegram и так ужимает фото до ~1280–2560 px
    const photo = message.photo[message.photo.length - 1]!;
    return { file: { tgFileId: photo.file_id, tgFileUniqueId: photo.file_unique_id, mime: "image/jpeg" }, source: "photo" };
  }
  const doc = message.document;
  if (!doc) return null;
  const mime = doc.mime_type ?? "";
  if (!SUPPORTED_DOCUMENT_MIME.has(mime)) {
    return { error: "😕 Этот файл я не распознаю. Пришлите фото, скриншот (JPG, PNG) или PDF-чек." };
  }
  if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
    return { error: "😕 Файл больше 20 МБ — Telegram не даёт боту его скачать. Пришлите фото или сожмите PDF." };
  }
  return {
    file: { tgFileId: doc.file_id, tgFileUniqueId: doc.file_unique_id, mime },
    source: mime === "application/pdf" ? "pdf" : "photo",
  };
}

receipts.on(["message:photo", "message:document"], async (ctx) => {
  const message = ctx.message;
  if (!ctx.member) {
    if (!isGroupChat(ctx)) await ctx.reply(`Сначала нужно присоединиться к семье. ${NEED_INVITE_TEXT}`);
    return;
  }
  const householdId = isGroupChat(ctx) ? await groupHouseholdId(ctx) : ctx.member.householdId;
  if (householdId !== ctx.member.householdId) return; // группа другой семьи

  const extracted = extractFile(message);
  if (!extracted) return;
  if ("error" in extracted) {
    await ctx.reply(extracted.error, { reply_parameters: { message_id: message.message_id } });
    return;
  }
  const db = ctx.env.DB;
  const replyTo = { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } };

  if (message.media_group_id) {
    const first = await addMediaGroupPart(
      db,
      { mediaGroupId: message.media_group_id, householdId, chatId: ctx.chat.id, addedBy: ctx.member.telegramId },
      { ...extracted.file, messageId: message.message_id },
    );
    if (!first) return;
    const status = await ctx.reply("⏳ Собираю альбом и распознаю чек…", replyTo);
    await setMediaGroupStatusMessage(db, message.media_group_id, status.message_id);
    await ctx.env.RECEIPT_QUEUE.send({ type: "album", mediaGroupId: message.media_group_id } satisfies ReceiptJob, {
      delaySeconds: ALBUM_DELAY_SECONDS,
    });
    return;
  }

  const existing = await findReceiptByFiles(db, householdId, [extracted.file.tgFileUniqueId]);
  if (existing) {
    const household = await getHousehold(db, householdId);
    await ctx.reply(
      `♻️ Этот чек уже добавлен: ${escapeHtml(existing.storeName ?? "чек")} от ` +
        `${formatDate(existing.purchasedAt, household?.timezone ?? ctx.env.DEFAULT_TZ)}, ${formatMoney(existing.totalMinor, existing.currency)}.`,
      { ...replyTo, parse_mode: "HTML", reply_markup: receiptKeyboard(ctx.env, { ...existing, chatId: ctx.chat.id }) },
    );
    return;
  }

  const status = await ctx.reply("⏳ Распознаю чек…", replyTo);
  await ctx.env.RECEIPT_QUEUE.send({
    type: "receipt",
    householdId,
    chatId: ctx.chat.id,
    addedBy: ctx.member.telegramId,
    statusMessageId: status.message_id,
    source: extracted.source,
    files: [extracted.file],
  } satisfies ReceiptJob);
});

// Кнопки под сводкой. Нажать может любой участник семьи (и в группе тоже).
receipts.callbackQuery(/^r:(save|del|delok|delno):(\d+)$/, async (ctx) => {
  if (!ctx.member) {
    await ctx.answerCallbackQuery({ text: "Кнопки доступны только участникам семьи.", show_alert: true });
    return;
  }
  const action = ctx.match[1];
  const receiptId = Number(ctx.match[2]);
  const { householdId, displayName } = ctx.member;
  const db = ctx.env.DB;

  const [receipt, household] = await Promise.all([getReceipt(db, householdId, receiptId), getHousehold(db, householdId)]);
  if (!receipt || !household) {
    await ctx.answerCallbackQuery({ text: "Чек не найден — возможно, его уже удалили." });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return;
  }

  const rerender = async (r: typeof receipt) => {
    const msg = await renderReceiptSummary(ctx.env, { ...r, chatId: ctx.chat?.id ?? r.chatId }, household.timezone);
    await ctx
      .editMessageText(msg.text, { parse_mode: "HTML", reply_markup: msg.reply_markup, link_preview_options: { is_disabled: true } })
      .catch((e) => {
        if (!isNotModified(e)) throw e;
      });
  };

  switch (action) {
    case "save":
      await setReceiptStatus(db, householdId, receiptId, "confirmed");
      await rerender({ ...receipt, status: "confirmed" });
      await ctx.answerCallbackQuery({ text: "Сохранено ✅" });
      return;
    case "del":
      await ctx.editMessageReplyMarkup({ reply_markup: deleteConfirmKeyboard(receiptId) });
      await ctx.answerCallbackQuery({ text: "Удалить чек?" });
      return;
    case "delno":
      await rerender(receipt);
      await ctx.answerCallbackQuery();
      return;
    case "delok":
      await deleteReceipt(db, householdId, receiptId);
      await ctx.editMessageText(
        `🗑 Чек удалён: ${escapeHtml(receipt.storeName ?? "без названия")}, ${formatMoney(receipt.totalMinor, receipt.currency)}. ` +
          `Удалил(а) ${escapeHtml(displayName)}.`,
        { parse_mode: "HTML" },
      );
      await ctx.answerCallbackQuery({ text: "Удалено" });
      return;
  }
});
