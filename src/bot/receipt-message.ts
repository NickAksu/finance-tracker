import type { Api } from "grammy";
import { getHousehold } from "../db/households";
import { getReceipt } from "../db/receipts";
import { createTelegramApi, isNotModified } from "../telegram";
import { renderReceiptSummary } from "./summary";

/**
 * Перерисовывает сводку чека в чате (после правки в Mini App или нажатия кнопки).
 * Ошибки Telegram не пробрасываются: сообщение могли удалить.
 */
export async function refreshReceiptMessage(env: Env, householdId: number, receiptId: number, api?: Api): Promise<void> {
  const [receipt, household] = await Promise.all([getReceipt(env.DB, householdId, receiptId), getHousehold(env.DB, householdId)]);
  if (!receipt?.messageId || !household) return;
  const msg = await renderReceiptSummary(env, receipt, household.timezone);
  try {
    await (api ?? createTelegramApi(env)).editMessageText(receipt.chatId, receipt.messageId, msg.text, {
      parse_mode: "HTML",
      reply_markup: msg.reply_markup,
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    if (!isNotModified(e)) console.warn("refreshReceiptMessage", receiptId, e);
  }
}
