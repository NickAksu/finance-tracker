import { nowIso } from "../lib/time";
import type { ReceiptFileRef, ReceiptSource } from "./receipts";

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

export interface EcrsReceiptRequest {
  uid: string;
  householdId: number;
  chatId: number;
  addedBy: number;
  statusMessageId: number | null;
  source: ReceiptSource;
  files: ReceiptFileRef[];
}

/** Отдельная задача на каждое фото: страницу скачает телефон, ответ уйдёт в этот чат. */
export async function enqueueEcrsReceipt(db: D1Database, req: EcrsReceiptRequest): Promise<number> {
  const now = nowIso();
  const row = await db
    .prepare(
      `INSERT INTO ecrs_jobs (uid, status, created_at, updated_at, household_id, chat_id, added_by, status_message_id, source, files_json)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      req.uid.toUpperCase(),
      now,
      now,
      req.householdId,
      req.chatId,
      req.addedBy,
      req.statusMessageId,
      req.source,
      JSON.stringify(req.files),
    )
    .first<{ id: number }>();
  if (!row) throw new Error("Не удалось поставить чек в очередь");
  return row.id;
}

export interface EcrsJobRecord {
  id: number;
  uid: string;
  status: string;
  html: string | null;
  householdId: number | null;
  chatId: number | null;
  addedBy: number | null;
  statusMessageId: number | null;
  source: ReceiptSource;
  files: ReceiptFileRef[];
}

export async function getEcrsJob(db: D1Database, id: number): Promise<EcrsJobRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, uid, status, html, household_id, chat_id, added_by, status_message_id, source, files_json
       FROM ecrs_jobs WHERE id = ?`,
    )
    .bind(id)
    .first<{
      id: number;
      uid: string;
      status: string;
      html: string | null;
      household_id: number | null;
      chat_id: number | null;
      added_by: number | null;
      status_message_id: number | null;
      source: string | null;
      files_json: string | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid,
    status: row.status,
    html: row.html,
    householdId: row.household_id,
    chatId: row.chat_id,
    addedBy: row.added_by,
    statusMessageId: row.status_message_id,
    source: asSource(row.source),
    files: parseFiles(row.files_json),
  };
}

function asSource(source: string | null): ReceiptSource {
  if (source === "photo" || source === "pdf" || source === "text" || source === "miniapp") return source;
  return "photo";
}

function parseFiles(raw: string | null): ReceiptFileRef[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const files: ReceiptFileRef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const file = item as Record<string, unknown>;
    if (typeof file.tgFileId !== "string" || typeof file.tgFileUniqueId !== "string" || typeof file.mime !== "string") continue;
    files.push({ tgFileId: file.tgFileId, tgFileUniqueId: file.tgFileUniqueId, mime: file.mime });
  }
  return files;
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
