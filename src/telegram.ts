import { autoRetry } from "@grammyjs/auto-retry";
import { Api } from "grammy";

/** Bot API с повтором запросов при 429 / 5xx. */
export function createTelegramApi(env: Env): Api {
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
  return api;
}

/** Лимит Bot API на скачивание файлов. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Скачивает файл из Telegram. Ссылка содержит токен бота — она не покидает Worker.
 */
export async function downloadTelegramFile(api: Api, token: string, fileId: string): Promise<ArrayBuffer> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram не вернул file_path");
  if (file.file_size && file.file_size > MAX_DOWNLOAD_BYTES) throw new FileTooLargeError();
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`Скачивание файла: HTTP ${res.status}`);
  return res.arrayBuffer();
}

export class FileTooLargeError extends Error {
  constructor() {
    super("Файл больше 20 МБ");
  }
}

/** Ошибка «message is not modified» при редактировании — не ошибка для нас. */
export function isNotModified(e: unknown): boolean {
  return e instanceof Error && e.message.includes("message is not modified");
}

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
