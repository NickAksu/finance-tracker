import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { createParser } from "../ai";
import type { ParseErrorKind, ReceiptFile } from "../ai/types";
import { receiptKeyboard, renderReceiptSummary } from "../bot/summary";
import { listActiveCategories } from "../db/categories";
import { getHousehold } from "../db/households";
import { takeMediaGroup } from "../db/media-groups";
import {
  findReceiptByFiles,
  getReceipt,
  insertParsedReceipt,
  setReceiptMessage,
  type ReceiptFileRef,
  type ReceiptSource,
} from "../db/receipts";
import { listRules } from "../db/rules";
import { formatMoney } from "../domain/money";
import { normalizeReceipt } from "../domain/normalize";
import { formatDate } from "../lib/time";
import { createTelegramApi, downloadTelegramFile, escapeHtml, FileTooLargeError, isNotModified } from "../telegram";
import { MAX_RECEIPT_ATTEMPTS, RETRY_DELAY_SECONDS, type ReceiptJob } from "./types";

interface ReceiptTask {
  householdId: number;
  chatId: number;
  addedBy: number;
  statusMessageId: number | null;
  source: ReceiptSource;
  files: ReceiptFileRef[];
  attempt: number;
}

/** Обработчик очереди: никогда не бросает, любая ошибка превращается в сообщение пользователю. */
export async function handleReceiptJob(env: Env, job: ReceiptJob): Promise<void> {
  const api = createTelegramApi(env);
  let task: ReceiptTask | null;
  if (job.type === "album") {
    const album = await takeMediaGroup(env.DB, job.mediaGroupId);
    if (!album || album.parts.length === 0) return;
    const { group, parts } = album;
    task = {
      householdId: group.householdId,
      chatId: group.chatId,
      addedBy: group.addedBy,
      statusMessageId: group.statusMessageId,
      source: parts.some((p) => p.mime === "application/pdf") ? "pdf" : "photo",
      files: parts,
      attempt: 1,
    };
  } else {
    task = { ...job, attempt: job.attempt ?? 1 };
  }

  const status = new StatusMessage(api, task.chatId, task.statusMessageId);
  try {
    await processReceipt(env, api, task, status);
  } catch (e) {
    console.error("receipt job failed", e);
    if (!(e instanceof FileTooLargeError) && (await scheduleRetry(env, task, status))) return;
    await status.show(
      e instanceof FileTooLargeError
        ? "😕 Файл больше 20 МБ — Telegram не даёт боту его скачать. Пришлите фото или сожмите PDF."
        : "😕 Не получилось обработать чек. Попробуйте прислать его ещё раз.",
    );
  }
}

async function processReceipt(env: Env, api: Api, task: ReceiptTask, status: StatusMessage): Promise<void> {
  const household = await getHousehold(env.DB, task.householdId);
  if (!household) return;

  // Повторное фото не тратит лимит ИИ
  const existing = await findReceiptByFiles(env.DB, household.id, task.files.map((f) => f.tgFileUniqueId));
  if (existing) {
    await status.show(
      `♻️ Этот чек уже добавлен: ${escapeHtml(existing.storeName ?? "чек")} от ${formatDate(existing.purchasedAt, household.timezone)}, ` +
        `${formatMoney(existing.totalMinor, existing.currency)}.`,
      receiptKeyboard(env, { ...existing, chatId: task.chatId }),
    );
    return;
  }

  const files: ReceiptFile[] = [];
  for (const f of task.files) {
    files.push({ data: await downloadTelegramFile(api, env.TELEGRAM_BOT_TOKEN, f.tgFileId), mime: f.mime });
  }

  const categories = await listActiveCategories(env.DB, household.id);
  const result = await createParser(env).parse(files, {
    categories: categories.map((c) => ({ code: c.code, name: c.name, description: c.description })),
    currency: household.currency,
    timezone: household.timezone,
    now: new Date(),
  });
  if (!result.ok) {
    console.warn("parse failed", result.model, result.error, result.message);
    if (RETRYABLE_ERRORS.has(result.error) && (await scheduleRetry(env, task, status))) return;
    await status.show(PARSE_ERROR_TEXT[result.error]);
    return;
  }

  const ai = result.receipt;
  if (ai.doc_type === "not_purchase") {
    const reason = ai.reason ? `\n<i>${escapeHtml(ai.reason)}</i>` : "";
    await status.show(
      `🤔 Не похоже на оплаченную покупку.${reason}\n\n` +
        "Пришлите кассовый чек, скриншот платежа ЕРИП или оплаченного заказа.",
    );
    return;
  }

  const normalized = normalizeReceipt(ai, {
    categories,
    rules: await listRules(env.DB, household.id),
    defaultCurrency: household.currency,
    timezone: household.timezone,
    now: new Date(),
  });

  const receiptId = await insertParsedReceipt(env.DB, {
    householdId: household.id,
    addedBy: task.addedBy,
    chatId: task.chatId,
    messageId: await status.ensureId(),
    source: task.source,
    receipt: normalized,
    files: task.files,
    aiModel: result.model,
    rawJson: result.raw,
  });
  if (receiptId === null) {
    await status.show("♻️ Этот чек уже добавлен — его только что прислали.");
    return;
  }

  const receipt = await getReceipt(env.DB, household.id, receiptId);
  if (!receipt) return;
  const msg = await renderReceiptSummary(env, receipt, household.timezone);
  await status.show(msg.text, msg.reply_markup);
  // «⏳» могли удалить — тогда сводка ушла новым сообщением
  if (status.id !== null && status.id !== receipt.messageId) {
    await setReceiptMessage(env.DB, household.id, receipt.id, status.id);
  }
}

/** Временные сбои: через минуту обычно проходят. */
const RETRYABLE_ERRORS: ReadonlySet<ParseErrorKind> = new Set(["timeout", "upstream", "rate_limited"]);

/**
 * Ставит повторную попытку в очередь с задержкой. Файлы уже известны, поэтому альбом
 * повторяется обычным заданием. false — попытки кончились или очередь недоступна.
 */
async function scheduleRetry(env: Env, task: ReceiptTask, status: StatusMessage): Promise<boolean> {
  if (task.attempt >= MAX_RECEIPT_ATTEMPTS) return false;
  try {
    const job: ReceiptJob = {
      type: "receipt",
      householdId: task.householdId,
      chatId: task.chatId,
      addedBy: task.addedBy,
      statusMessageId: await status.ensureId(),
      source: task.source,
      files: task.files,
      attempt: task.attempt + 1,
    };
    await env.RECEIPT_QUEUE.send(job, { delaySeconds: RETRY_DELAY_SECONDS });
  } catch (e) {
    console.error("retry scheduling failed", e);
    return false;
  }
  await status.show("⏳ Сервис распознавания сейчас перегружен — попробую ещё раз через минуту…").catch((e) => {
    console.warn("retry status failed", e);
  });
  return true;
}

const PARSE_ERROR_TEXT: Record<ParseErrorKind, string> = {
  rate_limited: "⏳ Лимит распознаваний на сегодня исчерпан. Попробуйте позже — чек можно прислать ещё раз.",
  timeout: "⌛ Распознавание заняло слишком много времени. Попробуйте ещё раз.",
  invalid_response: "😕 Не удалось разобрать чек. Попробуйте переснять: ровно, при хорошем свете, весь чек в кадре.",
  unsupported: "😕 Этот формат сейчас не распознаётся. Пришлите фото или скриншот.",
  upstream: "😕 Сервис распознавания недоступен. Попробуйте чуть позже.",
};

/** Сообщение «⏳ Распознаю чек…», которое превращается в результат. */
class StatusMessage {
  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private messageId: number | null,
  ) {}

  /** id сообщения-сводки; если «⏳» не было, создаёт его. */
  async ensureId(): Promise<number> {
    if (this.messageId === null) {
      const m = await this.api.sendMessage(this.chatId, "⏳ Распознаю чек…");
      this.messageId = m.message_id;
    }
    return this.messageId;
  }

  get id(): number | null {
    return this.messageId;
  }

  async show(text: string, reply_markup?: InlineKeyboardMarkup): Promise<void> {
    const opts = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true }, reply_markup };
    if (this.messageId !== null) {
      try {
        await this.api.editMessageText(this.chatId, this.messageId, text, opts);
        return;
      } catch (e) {
        if (isNotModified(e)) return;
        console.warn("edit status failed, sending new message", e);
      }
    }
    const m = await this.api.sendMessage(this.chatId, text, opts);
    this.messageId = m.message_id;
  }
}
