import { nowIso } from "../lib/time";

const LEASE_MS = 2 * 60 * 1000;

export interface EcrsJobRef {
  id: number;
  uid: string;
}

export async function enqueueEcrsJob(db: D1Database, uid: string): Promise<{ id: number; created: boolean }> {
  const existing = await db
    .prepare("SELECT id FROM ecrs_jobs WHERE uid = ? AND status IN ('pending', 'leased') ORDER BY id LIMIT 1")
    .bind(uid)
    .first<{ id: number }>();
  if (existing) return { id: existing.id, created: false };

  const now = nowIso();
  const row = await db
    .prepare("INSERT INTO ecrs_jobs (uid, status, created_at, updated_at) VALUES (?, 'pending', ?, ?) RETURNING id")
    .bind(uid, now, now)
    .first<{ id: number }>();
  if (!row) throw new Error("Не удалось поставить чек в очередь");
  return { id: row.id, created: true };
}

/** Забирает одну ожидающую задачу. Просроченная аренда снова доступна. */
export async function claimEcrsJob(db: D1Database, now = new Date()): Promise<EcrsJobRef | null> {
  const at = now.toISOString();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT id, uid FROM ecrs_jobs
       WHERE status = 'pending' OR (status = 'leased' AND lease_until < ?)
       ORDER BY id LIMIT 1`,
    )
    .bind(at)
    .first<EcrsJobRef>();
  if (!row) return null;

  const updated = await db
    .prepare(
      `UPDATE ecrs_jobs SET status = 'leased', lease_until = ?, updated_at = ?
       WHERE id = ? AND (status = 'pending' OR (status = 'leased' AND lease_until < ?))`,
    )
    .bind(until, at, row.id, at)
    .run();
  if (updated.meta.changes !== 1) return null;
  return row;
}

export async function finishEcrsJob(
  db: D1Database,
  id: number,
  result: { ok: true; html: string } | { ok: false; error: string },
): Promise<boolean> {
  const at = nowIso();
  if (result.ok) {
    const updated = await db
      .prepare(
        `UPDATE ecrs_jobs SET status = 'done', html = ?, error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'leased')`,
      )
      .bind(result.html, at, id)
      .run();
    return updated.meta.changes === 1;
  }
  const updated = await db
    .prepare(
      `UPDATE ecrs_jobs SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'leased')`,
    )
    .bind(result.error, at, id)
    .run();
  return updated.meta.changes === 1;
}
