import { addHours, nowIso } from "../lib/time";

const INVITE_TTL_HOURS = 24;

/** Одноразовый код приглашения (base64url, 96 бит). */
export async function createInvite(db: D1Database, householdId: number, createdBy: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const code = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
  await db
    .prepare("INSERT INTO invites (code, household_id, created_by, expires_at) VALUES (?, ?, ?, ?)")
    .bind(code, householdId, createdBy, addHours(new Date(), INVITE_TTL_HOURS).toISOString())
    .run();
  return code;
}

/** Погашает приглашение атомарно. Возвращает семью и автора или null (нет, истекло, использовано). */
export async function consumeInvite(
  db: D1Database,
  code: string,
  userId: number,
): Promise<{ householdId: number; createdBy: number } | null> {
  const now = nowIso();
  const row = await db
    .prepare(
      `UPDATE invites SET used_by = ?, used_at = ?
       WHERE code = ? AND used_by IS NULL AND expires_at > ?
       RETURNING household_id, created_by`,
    )
    .bind(userId, now, code, now)
    .first<{ household_id: number; created_by: number }>();
  return row && { householdId: row.household_id, createdBy: row.created_by };
}
