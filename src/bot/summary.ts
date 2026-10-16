import { InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { findSimilarReceipt, getCategoryTotals, type ReceiptHeader } from "../db/receipts";
import { formatMoney } from "../domain/money";
import { formatDate, formatDateTime } from "../lib/time";
import { escapeHtml } from "../telegram";

const DOC_ICON: Record<ReceiptHeader["docType"], string> = {
  store_receipt: "🧾",
  erip: "💳",
  online_order: "📦",
  manual: "✍️",
};

export interface RenderedMessage {
  text: string;
  reply_markup: InlineKeyboardMarkup;
}

/**
 * Сводка чека для чата: шапка, итог, суммы по категориям, предупреждения и кнопки.
 * Детали позиций — в Mini App.
 */
export async function renderReceiptSummary(env: Env, receipt: ReceiptHeader, timezone: string): Promise<RenderedMessage> {
  const [totals, similar] = await Promise.all([
    getCategoryTotals(env.DB, receipt.id),
    findSimilarReceipt(env.DB, receipt),
  ]);

  const title = escapeHtml(receipt.storeName ?? "Без названия");
  const erip = receipt.docType === "erip" ? ` (ЕРИП${receipt.eripAccount ? ` · л/с ${escapeHtml(receipt.eripAccount)}` : ""})` : "";
  const lines = [
    `${DOC_ICON[receipt.docType]} <b>${title}</b>${erip} · ${formatDateTime(receipt.purchasedAt, timezone)} · 👤 ${escapeHtml(receipt.addedByName)}`,
    `Итого: <b>${formatMoney(receipt.totalMinor, receipt.currency)}</b>`,
    "",
    ...totals.map((t) => `${t.emoji} ${escapeHtml(t.name)} — ${formatMoney(t.totalMinor, receipt.currency)} (${t.itemCount} поз.)`),
  ];

  const warnings: string[] = [];
  if (receipt.hasSumMismatch) {
    const sum = totals.reduce((acc, t) => acc + t.totalMinor, 0);
    warnings.push(`⚠️ Сумма позиций ${formatMoney(sum, receipt.currency)} не сходится с итогом — проверьте позиции.`);
  }
  if (receipt.confidence === "low") warnings.push("⚠️ Чек распознан неуверенно — проверьте позиции.");
  if (similar) {
    warnings.push(
      `⚠️ Похоже на дубликат: ${escapeHtml(similar.storeName ?? "чек")} от ${formatDate(similar.purchasedAt, timezone)} ` +
        `на ту же сумму уже добавил(а) ${escapeHtml(similar.addedByName)}.`,
    );
  }
  if (warnings.length) lines.push("", ...warnings);
  if (receipt.status === "confirmed") lines.push("", "✅ Сохранён");

  return { text: lines.join("\n"), reply_markup: receiptKeyboard(env, receipt) };
}

export function receiptKeyboard(env: Env, receipt: Pick<ReceiptHeader, "id" | "chatId" | "status">): InlineKeyboardMarkup {
  const kb = new InlineKeyboard();
  if (receipt.status === "draft") kb.text("✅ Сохранить", `r:save:${receipt.id}`);
  addEditButton(kb, env, receipt);
  kb.text("🗑 Удалить", `r:del:${receipt.id}`);
  return kb;
}

export function deleteConfirmKeyboard(receiptId: number): InlineKeyboardMarkup {
  return new InlineKeyboard().text("🗑 Да, удалить", `r:delok:${receiptId}`).text("↩️ Отмена", `r:delno:${receiptId}`);
}

/**
 * «Редактировать»: в личном чате — web_app-кнопка, в группе web_app не работает,
 * поэтому Direct Link на Mini App (startapp=r_<id>).
 */
function addEditButton(kb: InlineKeyboard, env: Env, receipt: Pick<ReceiptHeader, "id" | "chatId">): void {
  if (receipt.chatId > 0) {
    kb.webApp("✏️ Редактировать", `${env.PUBLIC_URL}/r/${receipt.id}`);
  } else if (env.MINIAPP_SHORT_NAME) {
    kb.url("✏️ Редактировать", miniAppLink(env, `r_${receipt.id}`));
  }
}

export function miniAppLink(env: Env, startParam?: string): string {
  const base = `https://t.me/${env.BOT_INFO.username}/${env.MINIAPP_SHORT_NAME}`;
  return startParam ? `${base}?startapp=${startParam}` : base;
}
