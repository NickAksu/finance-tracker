import type { ReceiptFileRef, ReceiptSource } from "../db/receipts";

/** Задания очереди RECEIPT_QUEUE. */
export type ReceiptJob =
  | {
      type: "receipt";
      householdId: number;
      chatId: number;
      addedBy: number;
      statusMessageId: number | null;
      source: ReceiptSource;
      files: ReceiptFileRef[];
      /** Номер попытки (по умолчанию 1); повтор ставит сам обработчик при временном сбое ИИ. */
      attempt?: number;
    }
  | {
      /** Альбом: части копятся в media_group_parts, задание приходит с задержкой. */
      type: "album";
      mediaGroupId: string;
    };

/** Сколько ждать остальные части альбома (Telegram присылает их отдельными апдейтами). */
export const ALBUM_DELAY_SECONDS = 3;

/** Сколько всего попыток распознать чек при временных сбоях (таймаут, перегрузка, лимит). */
export const MAX_RECEIPT_ATTEMPTS = 2;

/** Пауза перед повторной попыткой. */
export const RETRY_DELAY_SECONDS = 60;
