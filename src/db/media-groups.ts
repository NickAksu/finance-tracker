import { nowIso } from "../lib/time";
import type { ReceiptFileRef } from "./receipts";

export interface MediaGroup {
  mediaGroupId: string;
  householdId: number;
  chatId: number;
  addedBy: number;
  statusMessageId: number | null;
}

/**
 * Добавляет часть альбома. Возвращает true, если это первая часть:
 * её обработчик показывает «⏳» и ставит задание на склейку.
 */
export async function addMediaGroupPart(
  db: D1Database,
  group: Omit<MediaGroup, "statusMessageId">,
  part: ReceiptFileRef & { messageId: number },
): Promise<boolean> {
  const now = nowIso();
  const [created] = await db.batch<{ media_group_id: string }>([
    db
      .prepare(
        `INSERT INTO media_groups (media_group_id, household_id, chat_id, added_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING RETURNING media_group_id`,
      )
      .bind(group.mediaGroupId, group.householdId, group.chatId, group.addedBy, now),
    db
      .prepare(
        `INSERT INTO media_group_parts (media_group_id, message_id, tg_file_id, tg_file_unique_id, mime, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(group.mediaGroupId, part.messageId, part.tgFileId, part.tgFileUniqueId, part.mime, now),
  ]);
  return (created?.results.length ?? 0) > 0;
}

export async function setMediaGroupStatusMessage(db: D1Database, mediaGroupId: string, messageId: number): Promise<void> {
  await db.prepare("UPDATE media_groups SET status_message_id = ? WHERE media_group_id = ?").bind(messageId, mediaGroupId).run();
}

/** Забирает альбом целиком и удаляет его из очереди склейки. */
export async function takeMediaGroup(
  db: D1Database,
  mediaGroupId: string,
): Promise<{ group: MediaGroup; parts: ReceiptFileRef[] } | null> {
  const [groupRes, partsRes] = await db.batch([
    db
      .prepare("SELECT media_group_id, household_id, chat_id, added_by, status_message_id FROM media_groups WHERE media_group_id = ?")
      .bind(mediaGroupId),
    db
      .prepare("SELECT tg_file_id, tg_file_unique_id, mime FROM media_group_parts WHERE media_group_id = ? ORDER BY message_id")
      .bind(mediaGroupId),
    db.prepare("DELETE FROM media_group_parts WHERE media_group_id = ?").bind(mediaGroupId),
    db.prepare("DELETE FROM media_groups WHERE media_group_id = ?").bind(mediaGroupId),
  ]);
  const g = groupRes?.results[0] as
    | { media_group_id: string; household_id: number; chat_id: number; added_by: number; status_message_id: number | null }
    | undefined;
  if (!g) return null;
  const parts = (partsRes?.results ?? []) as { tg_file_id: string; tg_file_unique_id: string; mime: string }[];
  return {
    group: {
      mediaGroupId: g.media_group_id,
      householdId: g.household_id,
      chatId: g.chat_id,
      addedBy: g.added_by,
      statusMessageId: g.status_message_id,
    },
    parts: parts.map((p) => ({ tgFileId: p.tg_file_id, tgFileUniqueId: p.tg_file_unique_id, mime: p.mime })),
  };
}
