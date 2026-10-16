import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callback, GROUP, KATE, mockFetch, OWNER, photoMessage, privateChat, sendUpdate, STRANGER, textMessage } from "./helpers/telegram";

const TABLES = [
  "items", "receipt_files", "receipts", "category_rules", "categories", "invites", "chats", "members", "households",
  "processed_updates", "media_group_parts", "media_groups",
];

beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => vi.restoreAllMocks());

async function createFamily() {
  const tg = mockFetch();
  await sendUpdate(textMessage(OWNER, privateChat(OWNER), "/start"));
  const household = await env.DB.prepare("SELECT id FROM households").first<{ id: number }>();
  tg.spy.mockRestore();
  return household!.id;
}

async function addKate(householdId: number) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO members (telegram_id, household_id, display_name, role, created_at) VALUES (?, ?, 'Kate', 'member', '')").bind(KATE.id, householdId),
    env.DB.prepare("INSERT INTO chats (chat_id, household_id, type, created_at) VALUES (?, ?, 'private', '')").bind(KATE.id, householdId),
  ]);
}

describe("вебхук", () => {
  it("отклоняет запрос без секрета", async () => {
    mockFetch();
    const res = await sendUpdate(textMessage(OWNER, privateChat(OWNER), "/start"), "wrong");
    expect(res.status).toBe(401);
  });

  it("не обрабатывает повторный апдейт", async () => {
    const tg = mockFetch();
    const update = { update_id: 777, ...textMessage(OWNER, privateChat(OWNER), "/help") };
    await sendUpdate(update);
    await sendUpdate(update);
    expect(tg.methods().filter((m) => m === "sendMessage")).toHaveLength(1);
  });
});

describe("доступ и семья", () => {
  it("вежливо отказывает постороннему в личке", async () => {
    const tg = mockFetch();
    await sendUpdate(textMessage(STRANGER, privateChat(STRANGER), "/start"));
    expect(tg.calls[0]?.body.text).toContain("доступ к нему закрыт");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM households").first("n")).toBe(0);
  });

  it("/start создаёт семью со стандартными категориями", async () => {
    const householdId = await createFamily();
    const cats = await env.DB.prepare("SELECT count(*) AS n FROM categories WHERE household_id = ?").bind(householdId).first("n");
    expect(cats).toBe(14);
    const owner = await env.DB.prepare("SELECT role FROM members WHERE telegram_id = ?").bind(OWNER.id).first("role");
    expect(owner).toBe("owner");
  });

  it("Kate вступает по приглашению, ссылка одноразовая", async () => {
    const householdId = await createFamily();
    const tg = mockFetch();
    await sendUpdate(textMessage(OWNER, privateChat(OWNER), "/invite"));
    const link = /start=join_(\S+)/.exec(tg.calls[0]!.body.text)!;
    await sendUpdate(textMessage(KATE, privateChat(KATE), `/start join_${link[1]}`));

    const kate = await env.DB.prepare("SELECT household_id FROM members WHERE telegram_id = ?").bind(KATE.id).first("household_id");
    expect(kate).toBe(householdId);
    expect(tg.calls.some((c) => c.method === "sendMessage" && c.body.chat_id === OWNER.id && c.body.text.includes("Kate"))).toBe(true);

    await sendUpdate(textMessage(STRANGER, privateChat(STRANGER), `/start join_${link[1]}`));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM members").first("n")).toBe(2);
  });

  it("Kate без приглашения создала пустую семью — приглашение переводит её в общую", async () => {
    const householdId = await createFamily();
    const tg = mockFetch();
    await sendUpdate(textMessage(KATE, privateChat(KATE), "/start"));
    await sendUpdate(textMessage(OWNER, privateChat(OWNER), "/invite"));
    const code = /start=join_(\S+)/.exec(tg.calls.at(-1)!.body.text)![1];
    await sendUpdate(textMessage(KATE, privateChat(KATE), `/start join_${code}`));

    expect(await env.DB.prepare("SELECT household_id FROM members WHERE telegram_id = ?").bind(KATE.id).first("household_id")).toBe(householdId);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM households").first("n")).toBe(1);
  });
});

describe("группа", () => {
  const added = (from: object) => ({
    my_chat_member: {
      chat: GROUP,
      from,
      date: 1,
      old_chat_member: { status: "left", user: { id: env.BOT_INFO.id, is_bot: true, first_name: "bot" } },
      new_chat_member: { status: "member", user: { id: env.BOT_INFO.id, is_bot: true, first_name: "bot" } },
    },
  });

  it("участник добавил бота — группа привязана к семье", async () => {
    const householdId = await createFamily();
    mockFetch();
    await sendUpdate(added(OWNER));
    const chat = await env.DB.prepare("SELECT household_id, type FROM chats WHERE chat_id = ?").bind(GROUP.id).first();
    expect(chat).toEqual({ household_id: householdId, type: "group" });
  });

  it("посторонний добавил бота — бот выходит", async () => {
    await createFamily();
    const tg = mockFetch();
    await sendUpdate(added(STRANGER));
    expect(tg.methods()).toContain("leaveChat");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM chats WHERE chat_id = ?").bind(GROUP.id).first("n")).toBe(0);
  });

  it("миграция в супергруппу обновляет chat_id", async () => {
    await createFamily();
    mockFetch();
    await sendUpdate(added(OWNER));
    await sendUpdate({ message: { message_id: 5, date: 1, from: OWNER, chat: GROUP, migrate_to_chat_id: -100777 } });
    const chat = await env.DB.prepare("SELECT type FROM chats WHERE chat_id = ?").bind(-100777).first("type");
    expect(chat).toBe("supergroup");
  });

  it("обычную переписку в группе игнорирует без запросов к D1", async () => {
    await createFamily();
    const tg = mockFetch();
    await sendUpdate(textMessage(OWNER, GROUP, "купи хлеба"));
    expect(tg.calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM processed_updates").first("n")).toBe(1); // только /start
  });
});

describe("приём фото", () => {
  it("фото из лички: «⏳» ответом и задание в очередь", async () => {
    const householdId = await createFamily();
    const tg = mockFetch();
    const send = vi.spyOn(env.RECEIPT_QUEUE, "send").mockResolvedValue(undefined as never);
    await sendUpdate(photoMessage(OWNER, privateChat(OWNER), "uniq1"));

    expect(tg.calls[0]?.body.text).toContain("Распознаю");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "receipt",
        householdId,
        addedBy: OWNER.id,
        files: [{ tgFileId: "big_uniq1", tgFileUniqueId: "uniq1", mime: "image/jpeg" }],
      }),
    );
  });

  it("фото от Kate в группе: автор — Kate", async () => {
    const householdId = await createFamily();
    await addKate(householdId);
    mockFetch();
    const send = vi.spyOn(env.RECEIPT_QUEUE, "send").mockResolvedValue(undefined as never);
    await sendUpdate(photoMessage(KATE, GROUP, "uniq2"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ chatId: GROUP.id, addedBy: KATE.id, householdId }));
  });

  it("альбом: одно «⏳» и одно отложенное задание", async () => {
    await createFamily();
    const tg = mockFetch();
    const send = vi.spyOn(env.RECEIPT_QUEUE, "send").mockResolvedValue(undefined as never);
    await sendUpdate(photoMessage(OWNER, privateChat(OWNER), "a1", "album1"));
    await sendUpdate(photoMessage(OWNER, privateChat(OWNER), "a2", "album1"));

    expect(tg.methods().filter((m) => m === "sendMessage")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "album", mediaGroupId: "album1" }, { delaySeconds: 3 });
    const parts = await env.DB.prepare("SELECT count(*) AS n FROM media_group_parts").first("n");
    expect(parts).toBe(2);
  });

  it("неподдерживаемый документ — понятный ответ", async () => {
    await createFamily();
    const tg = mockFetch();
    await sendUpdate({
      message: {
        message_id: 9, date: 1, from: OWNER, chat: privateChat(OWNER),
        document: { file_id: "d", file_unique_id: "du", mime_type: "application/zip", file_size: 10 },
      },
    });
    expect(tg.calls[0]?.body.text).toContain("не распознаю");
  });
});

describe("кнопки под сводкой", () => {
  async function insertReceipt(householdId: number) {
    const cat = await env.DB.prepare("SELECT id FROM categories WHERE household_id = ? AND code = 'groceries'").bind(householdId).first<number>("id");
    const r = await env.DB.prepare(
      `INSERT INTO receipts (household_id, added_by, chat_id, message_id, store_name, purchased_at, total_minor, currency, source, doc_type, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'Евроопт', '2026-10-05T11:32:00.000Z', 7845, 'BYN', 'photo', 'store_receipt', 'draft', '', '') RETURNING id`,
    ).bind(householdId, KATE.id, GROUP.id).first<number>("id");
    await env.DB.prepare("INSERT INTO items (receipt_id, position, name, total_minor, category_id, category_source) VALUES (?, 1, 'Молоко', 7845, ?, 'ai')").bind(r, cat).run();
    return r!;
  }

  it("«Сохранить» в группе может нажать другой участник", async () => {
    const householdId = await createFamily();
    await addKate(householdId);
    const id = await insertReceipt(householdId);
    const tg = mockFetch();
    await sendUpdate(callback(OWNER, GROUP, `r:save:${id}`));

    expect(await env.DB.prepare("SELECT status FROM receipts WHERE id = ?").bind(id).first("status")).toBe("confirmed");
    const edit = tg.calls.find((c) => c.method === "editMessageText")!;
    expect(edit.body.text).toContain("Евроопт");
    expect(edit.body.text).toContain("78,45");
    expect(edit.body.text).toContain("👤 Kate");
    expect(edit.body.text).toContain("✅ Сохранён");
    // в группе «Редактировать» — Direct Link, а не web_app
    const buttons = JSON.stringify(edit.body.reply_markup);
    expect(buttons).toContain(`startapp=r_${id}`);
    expect(buttons).not.toContain("web_app");
  });

  it("удаление — с подтверждением", async () => {
    const householdId = await createFamily();
    await addKate(householdId);
    const id = await insertReceipt(householdId);
    const tg = mockFetch();
    await sendUpdate(callback(OWNER, GROUP, `r:del:${id}`));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM receipts").first("n")).toBe(1);
    expect(JSON.stringify(tg.calls.find((c) => c.method === "editMessageReplyMarkup")?.body)).toContain(`r:delok:${id}`);

    await sendUpdate(callback(OWNER, GROUP, `r:delok:${id}`));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM receipts").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM items").first("n")).toBe(0);
  });

  it("чужой чек (другая семья) не трогается", async () => {
    const householdId = await createFamily();
    const id = await insertReceipt(householdId);
    const otherId = await env.DB.prepare("INSERT INTO households (created_at) VALUES ('') RETURNING id").first<number>("id");
    await env.DB.prepare("UPDATE receipts SET household_id = ? WHERE id = ?").bind(otherId, id).run();
    mockFetch();
    await sendUpdate(callback(OWNER, privateChat(OWNER), `r:delok:${id}`));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM receipts").first("n")).toBe(1);
  });
});
