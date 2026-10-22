import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { renderReceiptSummary } from "../bot/summary";
import { listActiveCategories } from "../db/categories";
import { getEcrsJob } from "../db/ecrs";
import { getHousehold } from "../db/households";
import { findReceiptByFiles, getReceipt, insertParsedReceipt, setReceiptMessage } from "../db/receipts";
import { listRules } from "../db/rules";
import { parseEcrsHtml } from "../domain/ecrs";
import { normalizeReceipt } from "../domain/normalize";
import { createTelegramApi, isNotModified } from "../telegram";

const FETCH_FAILED =
  "😕 Не получилось скачать электронный чек. Домашний телефон должен быть включён, на зарядке и в домашнем Wi-Fi. Пришлите фото ещё раз.";
const PARSE_FAILED = "😕 Страница чека открылась, но разобрать её не вышло. Пришлите фото ещё раз.";
const SAVE_FAILED = "😕 Электронный чек скачался, но сохранить его не получилось. Пришлите фото ещё раз.";

/** После ответа телефона: страница → чек в базе → сводка в том же сообщении. Без чата только хранит HTML. */
export async function settleEcrsJob(env: Env, id: number): Promise<void> {
  const job = await getEcrsJob(env.DB, id);
  if (!job || job.householdId == null || job.chatId == null || job.addedBy == null) return;

  const api = createTelegramApi(env);
  const chatId = job.chatId;
  let messageId = job.statusMessageId;
  try {
    if (job.status !== "done" || !job.html) {
      await show(api, chatId, messageId, FETCH_FAILED);
      return;
    }
    const ai = parseEcrsHtml(job.html);
    if (!ai) {
      await show(api, chatId, messageId, PARSE_FAILED);
      return;
    }
    const household = await getHousehold(env.DB, job.householdId);
    if (!household) return;

    const normalized = normalizeReceipt(ai, {
      categories: await listActiveCategories(env.DB, household.id),
      rules: await listRules(env.DB, household.id),
      defaultCurrency: household.currency,
      timezone: household.timezone,
      now: new Date(),
    });
    const receiptId = await insertParsedReceipt(env.DB, {
      householdId: household.id,
      addedBy: job.addedBy,
      chatId,
      messageId,
      source: job.source,
      receipt: normalized,
      files: job.files,
      aiModel: "ecrs",
      rawJson: JSON.stringify(ai),
    });

    if (receiptId === null) {
      const existing = await findReceiptByFiles(
        env.DB,
        household.id,
        job.files.map((file) => file.tgFileUniqueId),
      );
      if (!existing) {
        await show(api, chatId, messageId, "♻️ Этот чек уже добавлен.");
        return;
      }
      const duplicate = await renderReceiptSummary(env, { ...existing, chatId }, household.timezone);
      await show(api, chatId, messageId, `♻️ Этот чек уже добавлен.\n\n${duplicate.text}`, duplicate.reply_markup);
      return;
    }

    const receipt = await getReceipt(env.DB, household.id, receiptId);
    if (!receipt) return;
    const msg = await renderReceiptSummary(env, receipt, household.timezone);
    messageId = await show(api, chatId, messageId, msg.text, msg.reply_markup);
    if (messageId !== null && messageId !== receipt.messageId) {
      await setReceiptMessage(env.DB, household.id, receipt.id, messageId);
    }
  } catch (error) {
    console.error("ecrs settle", error);
    await show(api, chatId, messageId, SAVE_FAILED).catch((sendError) => {
      console.error("ecrs status failed", sendError);
    });
  }
}

async function show(
  api: Api,
  chatId: number,
  messageId: number | null,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<number | null> {
  const extra = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true }, reply_markup: replyMarkup };
  if (messageId !== null) {
    try {
      await api.editMessageText(chatId, messageId, text, extra);
      return messageId;
    } catch (error) {
      if (isNotModified(error)) return messageId;
      console.warn("ecrs edit failed", error);
    }
  }
  const sent = await api.sendMessage(chatId, text, extra);
  return sent.message_id;
}
