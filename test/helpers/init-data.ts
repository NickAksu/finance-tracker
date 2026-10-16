// Тестовый генератор initData Telegram Mini App: считает подпись по спецификации,
// независимо от src/api/auth.ts (своя реализация HMAC через WebCrypto).

const encoder = new TextEncoder();

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SignInitDataInput {
  user?: Record<string, unknown>;
  authDate?: number;
  startParam?: string;
  extra?: Record<string, string>;
}

/** Возвращает строку initData (query string) с корректным `hash`. */
export async function signInitData(botToken: string, input: SignInitDataInput = {}): Promise<string> {
  const fields: Record<string, string> = {
    auth_date: String(input.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    ...(input.user ? { user: JSON.stringify(input.user) } : {}),
    ...(input.startParam ? { start_param: input.startParam } : {}),
    ...input.extra,
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = await hmac(encoder.encode("WebAppData"), botToken);
  const hash = toHex(await hmac(secretKey, dataCheckString));
  return new URLSearchParams({ ...fields, hash }).toString();
}
