import { nowIso } from "../lib/time";

/** true — апдейт новый; false — Telegram прислал его повторно. */
export async function markUpdateProcessed(db: D1Database, updateId: number): Promise<boolean> {
  const res = await db
    .prepare("INSERT INTO processed_updates (update_id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(updateId, nowIso())
    .run();
  return res.meta.changes > 0;
}

/** Чистка служебных таблиц (cron). */
export async function cleanupServiceTables(db: D1Database, now: Date = new Date()): Promise<void> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM processed_updates WHERE created_at < ?").bind(weekAgo),
    db.prepare("DELETE FROM media_group_parts WHERE created_at < ?").bind(dayAgo),
    db.prepare("DELETE FROM media_groups WHERE created_at < ?").bind(dayAgo),
    db.prepare("DELETE FROM invites WHERE expires_at < ? AND used_by IS NULL").bind(weekAgo),
  ]);
}
