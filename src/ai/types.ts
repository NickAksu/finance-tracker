// Контракт распознавания. Реализации: GeminiParser (основной), WorkersAiParser (запасной).

/** Файл чека, уже скачанный из Telegram. */
export interface ReceiptFile {
  data: ArrayBuffer;
  /** image/jpeg | image/png | image/webp | application/pdf */
  mime: string;
}

/** Категория в том виде, в каком её видит модель. `code` идёт в enum JSON-схемы. */
export interface CategoryForAi {
  code: string;
  name: string;
  description: string | null;
}

export interface ParseContext {
  /** Активные категории семьи; среди них всегда есть `other`. */
  categories: CategoryForAi[];
  /** Валюта по умолчанию, если на чеке не указана (BYN). */
  currency: string;
  /** Часовой пояс семьи (Europe/Minsk) — для подсказки модели о текущей дате. */
  timezone: string;
  now: Date;
}

export type DocType = "store_receipt" | "erip" | "online_order" | "not_purchase";
export type Confidence = "low" | "medium" | "high";

/** Ответ модели после валидации zod. Суммы — в основных единицах (рубли), как на чеке. */
export interface AiReceipt {
  doc_type: DocType;
  /** Магазин или поставщик услуги. */
  store_name: string | null;
  /** Локальное время покупки/оплаты как на чеке: "YYYY-MM-DDTHH:mm" или "YYYY-MM-DD"; null, если не видно. */
  purchased_at: string | null;
  /** ISO 4217 (BYN, RUB, USD…); null, если не указано. */
  currency: string | null;
  /** Фактически списанная сумма, включая комиссию/сервисный сбор. */
  total_amount: number | null;
  /** Комиссия ЕРИП или сервисный сбор, который НЕ включён в items (0, если нет). */
  fee_amount: number;
  /** Лицевой счёт / номер договора (только ЕРИП). */
  erip_account: string | null;
  items: AiItem[];
  confidence: Confidence;
  /** Для not_purchase — коротко почему (корзина, неоплаченный заказ, не документ). */
  reason: string | null;
}

export interface AiItem {
  name: string;
  quantity: number;
  /** Цена за единицу; null, если не видна. */
  price: number | null;
  /** Скидка на строку (положительное число), 0 если нет. */
  discount: number;
  /** Итог строки после скидки; null, если не виден (тогда price * quantity - discount). */
  line_total: number | null;
  /** Код категории из ParseContext.categories. */
  category: string;
}

export type ParseErrorKind =
  | "rate_limited" // 429 / квота
  | "timeout"
  | "invalid_response" // не JSON или не прошёл схему
  | "unsupported" // формат не поддерживается движком (например, PDF у Workers AI)
  | "upstream"; // прочие ошибки сервиса

export type ParseResult =
  | { ok: true; receipt: AiReceipt; model: string; raw: string }
  | { ok: false; error: ParseErrorKind; message: string; model: string; raw?: string };

export interface ReceiptParser {
  readonly name: string;
  parse(files: ReceiptFile[], ctx: ParseContext, signal?: AbortSignal): Promise<ParseResult>;
}
