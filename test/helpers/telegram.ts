// Тестовая обвязка: апдейты Telegram через настоящий fetch воркера и подменённый Bot API.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../../src/index";

export const OWNER = { id: 861165606, is_bot: false, first_name: "Ник" };
export const KATE = { id: 470022139, is_bot: false, first_name: "Kate" };
export const STRANGER = { id: 1111, is_bot: false, first_name: "Чужой" };
export const GROUP = { id: -100500, type: "group" as const, title: "Семья" };

export interface ApiCall {
  method: string;
  body: Record<string, any>;
}

let updateId = 1;
let messageId = 1000;

/**
 * Подменяет fetch: запросы к api.telegram.org записываются и получают правдоподобный ответ,
 * остальные хосты обслуживает `other` (например, Gemini).
 */
export function mockFetch(other?: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: ApiCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname === "api.telegram.org") {
      if (url.pathname.startsWith("/file/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      const method = url.pathname.split("/").pop()!;
      const body = req.method === "POST" ? await parseBody(req) : {};
      calls.push({ method, body });
      return Response.json({ ok: true, result: fakeResult(method, body) });
    }
    if (other) return other(url, init);
    throw new Error(`Неожиданный запрос: ${url}`);
  });
  return { calls, spy, methods: () => calls.map((c) => c.method) };
}

async function parseBody(req: Request): Promise<Record<string, any>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("json")) return req.json();
  if (type.includes("form")) return Object.fromEntries((await req.formData()).entries());
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

function fakeResult(method: string, body: Record<string, any>): unknown {
  switch (method) {
    case "sendMessage":
      return { message_id: ++messageId, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text };
    case "editMessageText":
      return { message_id: body.message_id, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text };
    case "getFile":
      return { file_id: body.file_id, file_unique_id: "u", file_size: 4, file_path: "photos/file_1.jpg" };
    default:
      return true;
  }
}

export async function sendUpdate(update: Record<string, unknown>, secret = env.WEBHOOK_SECRET): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://bot.test/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: ++updateId, ...update }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

type Chat = { id: number; type: "private" | "group" | "supergroup"; title?: string };

export function privateChat(user: { id: number; first_name: string }): Chat {
  return { id: user.id, type: "private" };
}

export function textMessage(from: object, chat: Chat, text: string) {
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined;
  return { message: { message_id: ++messageId, date: 1, from, chat, text, entities } };
}

export function photoMessage(from: object, chat: Chat, uniqueId: string, mediaGroupId?: string) {
  return {
    message: {
      message_id: ++messageId,
      date: 1,
      from,
      chat,
      media_group_id: mediaGroupId,
      photo: [
        { file_id: `small_${uniqueId}`, file_unique_id: `s_${uniqueId}`, width: 90, height: 160 },
        { file_id: `big_${uniqueId}`, file_unique_id: uniqueId, width: 720, height: 1280 },
      ],
    },
  };
}

export function callback(from: object, chat: Chat, data: string, msgId = 1) {
  return {
    callback_query: {
      id: String(++messageId),
      from,
      chat_instance: "x",
      data,
      message: { message_id: msgId, date: 1, chat, text: "сводка" },
    },
  };
}
