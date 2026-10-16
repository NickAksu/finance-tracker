// Проверка initData Telegram Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
//
//   data_check_string = все полученные поля, кроме `hash`, в виде key=<value>,
//                       отсортированные по ключу и склеенные через "\n";
//   secret_key        = HMAC_SHA256(key = "WebAppData", msg = bot_token);
//   valid            <=> hex(HMAC_SHA256(key = secret_key, msg = data_check_string)) == hash.
//
// Поле `signature` (Ed25519, Bot API 8.0+) предназначено для проверки третьими сторонами без токена.
// Для HMAC-проверки документация исключает только `hash` («a chain of all received fields»),
// поэтому `signature` входит в data-check-string наравне с остальными полями. Из строки исключают
// и `hash`, и `signature` только при Ed25519-проверке (её мы не делаем: токен бота у нас есть).
import { z } from "zod";

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface ValidatedInitData {
  user: TelegramWebAppUser;
  /** Unix-время (секунды), когда Mini App получил данные. */
  authDate: number;
  /** `startapp`-параметр Direct Link (например, `r_123`), если был. */
  startParam?: string;
}

export type InitDataFailureReason =
  | "malformed" // не query string, дубли ключей, битый JSON user и т. п.
  | "missing_hash"
  | "bad_hash"
  | "missing_auth_date"
  | "expired"
  | "auth_date_in_future"
  | "missing_user";

export type InitDataValidationResult =
  | { ok: true; data: ValidatedInitData }
  | { ok: false; reason: InitDataFailureReason };

export interface ValidateInitDataOptions {
  /** Максимальный возраст auth_date в секундах (по умолчанию 24 ч). */
  maxAgeSeconds?: number;
  /** Допустимый «перекос часов» в будущее, секунды (по умолчанию 60). */
  maxFutureSkewSeconds?: number;
  /** Текущее время в секундах (для тестов). */
  nowSeconds?: number;
}

export const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 60;

const userSchema = z.object({
  id: z.number().int(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.boolean().optional(),
  photo_url: z.string().optional(),
});

const encoder = new TextEncoder();

async function hmacKey(rawKey: BufferSource, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Строит data-check-string из пар (без `hash`), сортируя по ключу. */
export function buildDataCheckString(fields: Iterable<[string, string]>): string {
  return [...fields]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * Проверяет подпись и свежесть initData. Никогда не бросает исключений на плохих входных данных.
 */
export async function validateInitData(
  initData: string,
  botToken: string,
  options: ValidateInitDataOptions = {},
): Promise<InitDataValidationResult> {
  const maxAge = options.maxAgeSeconds ?? DEFAULT_INIT_DATA_MAX_AGE_SECONDS;
  const maxSkew = options.maxFutureSkewSeconds ?? DEFAULT_MAX_FUTURE_SKEW_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const fields = new Map<string, string>();
  for (const [key, value] of params) {
    if (fields.has(key)) return { ok: false, reason: "malformed" }; // дубли ключей — подозрительно
    fields.set(key, value);
  }

  const hash = fields.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };
  const hashBytes = hexToBytes(hash);
  if (!hashBytes) return { ok: false, reason: "bad_hash" };

  const dataCheckString = buildDataCheckString(fields);
  const secretKeyBytes = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(encoder.encode("WebAppData"), "sign"),
    encoder.encode(botToken),
  );
  // crypto.subtle.verify для HMAC сравнивает подписи за постоянное время.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secretKeyBytes, "verify"),
    hashBytes,
    encoder.encode(dataCheckString),
  );
  if (!valid) return { ok: false, reason: "bad_hash" };

  // Дальше данные подписаны Telegram — проверяем свежесть и разбираем поля.
  const authDateRaw = fields.get("auth_date");
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) return { ok: false, reason: "missing_auth_date" };
  const authDate = Number(authDateRaw);
  if (now - authDate > maxAge) return { ok: false, reason: "expired" };
  if (authDate - now > maxSkew) return { ok: false, reason: "auth_date_in_future" };

  const userRaw = fields.get("user");
  if (!userRaw) return { ok: false, reason: "missing_user" };
  let userJson: unknown;
  try {
    userJson = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const user = userSchema.safeParse(userJson);
  if (!user.success) return { ok: false, reason: "malformed" };

  const startParam = fields.get("start_param");
  return {
    ok: true,
    data: { user: user.data, authDate, ...(startParam ? { startParam } : {}) },
  };
}
