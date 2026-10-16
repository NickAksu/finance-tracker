import { nowIso } from "../lib/time";

export type ChatType = "private" | "group" | "supergroup";

export interface ChatLink {
  chatId: number;
  householdId: number;
  type: ChatType;
  title: string | null;
}

export async function getChatLink(db: D1Database, chatId: number): Promise<ChatLink | null> {
  const row = await db
    .prepare("SELECT chat_id, household_id, type, title FROM chats WHERE chat_id = ?")
    .bind(chatId)
    .first<{ chat_id: number; household_id: number; type: ChatType; title: string | null }>();
  return row && { chatId: row.chat_id, householdId: row.household_id, type: row.type, title: row.title };
}

export async function getGroupChat(db: D1Database, householdId: number): Promise<ChatLink | null> {
  const row = await db
    .prepare("SELECT chat_id, household_id, type, title FROM chats WHERE household_id = ? AND type != 'private'")
    .bind(householdId)
    .first<{ chat_id: number; household_id: number; type: ChatType; title: string | null }>();
  return row && { chatId: row.chat_id, householdId: row.household_id, type: row.type, title: row.title };
}

/** Личный чат участника всегда привязан к его семье. */
export async function linkPrivateChat(db: D1Database, chatId: number, householdId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chats (chat_id, household_id, type, created_at) VALUES (?, ?, 'private', ?)
       ON CONFLICT (chat_id) DO UPDATE SET household_id = excluded.household_id`,
    )
    .bind(chatId, householdId, nowIso())
    .run();
}

/**
 * Привязывает группу к семье. У семьи одна группа: прежняя привязка снимается.
 * Возвращает id прежней группы, если она была другой.
 */
export async function bindGroup(
  db: D1Database,
  opts: { chatId: number; householdId: number; type: "group" | "supergroup"; title: string | null },
): Promise<number | null> {
  const previous = await getGroupChat(db, opts.householdId);
  await db.batch([
    db.prepare("DELETE FROM chats WHERE household_id = ? AND type != 'private' AND chat_id != ?").bind(opts.householdId, opts.chatId),
    db
      .prepare(
        `INSERT INTO chats (chat_id, household_id, type, title, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET household_id = excluded.household_id, type = excluded.type, title = excluded.title`,
      )
      .bind(opts.chatId, opts.householdId, opts.type, opts.title, nowIso()),
  ]);
  return previous && previous.chatId !== opts.chatId ? previous.chatId : null;
}

export async function unlinkChat(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("DELETE FROM chats WHERE chat_id = ?").bind(chatId).run();
}

/** Группа стала супергруппой: chat_id меняется. Идемпотентно (приходит и в старый, и в новый чат). */
export async function migrateChat(db: D1Database, oldChatId: number, newChatId: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE chats SET chat_id = ?, type = 'supergroup'
         WHERE chat_id = ? AND NOT EXISTS (SELECT 1 FROM chats WHERE chat_id = ?)`,
      )
      .bind(newChatId, oldChatId, newChatId),
    db.prepare("UPDATE receipts SET chat_id = ? WHERE chat_id = ?").bind(newChatId, oldChatId),
  ]);
}
