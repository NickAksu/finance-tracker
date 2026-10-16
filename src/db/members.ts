import type { Household } from "./households";
import { nowIso } from "../lib/time";

export type MemberRole = "owner" | "member";

export interface Member {
  telegramId: number;
  householdId: number;
  displayName: string;
  role: MemberRole;
}

export interface MemberContext {
  member: { telegramId: number; displayName: string; role: MemberRole };
  household: Household;
}

interface MemberRow {
  telegram_id: number;
  household_id: number;
  display_name: string;
  role: MemberRole;
}

export async function getMember(db: D1Database, telegramId: number): Promise<Member | null> {
  const row = await db
    .prepare("SELECT telegram_id, household_id, display_name, role FROM members WHERE telegram_id = ?")
    .bind(telegramId)
    .first<MemberRow>();
  return row && toMember(row);
}

export async function getMemberContext(db: D1Database, telegramId: number): Promise<MemberContext | null> {
  const row = await db
    .prepare(
      `SELECT m.telegram_id, m.display_name, m.role, h.id, h.name, h.timezone, h.currency
       FROM members m JOIN households h ON h.id = m.household_id
       WHERE m.telegram_id = ?`,
    )
    .bind(telegramId)
    .first<{ telegram_id: number; display_name: string; role: MemberRole; id: number; name: string; timezone: string; currency: string }>();
  if (!row) return null;
  return {
    member: { telegramId: row.telegram_id, displayName: row.display_name, role: row.role },
    household: { id: row.id, name: row.name, timezone: row.timezone, currency: row.currency },
  };
}

export async function listMembers(
  db: D1Database,
  householdId: number,
): Promise<{ telegramId: number; displayName: string; role: MemberRole }[]> {
  const { results } = await db
    .prepare("SELECT telegram_id, household_id, display_name, role FROM members WHERE household_id = ? ORDER BY created_at")
    .bind(householdId)
    .all<MemberRow>();
  return results.map((r) => ({ telegramId: r.telegram_id, displayName: r.display_name, role: r.role }));
}

/** Участник вступает в семью; его личный чат привязывается к ней же. */
export async function addMember(
  db: D1Database,
  opts: { telegramId: number; householdId: number; displayName: string },
): Promise<void> {
  const createdAt = nowIso();
  await db.batch([
    db
      .prepare("INSERT INTO members (telegram_id, household_id, display_name, role, created_at) VALUES (?, ?, ?, 'member', ?)")
      .bind(opts.telegramId, opts.householdId, opts.displayName, createdAt),
    db
      .prepare(
        `INSERT INTO chats (chat_id, household_id, type, created_at) VALUES (?, ?, 'private', ?)
         ON CONFLICT (chat_id) DO UPDATE SET household_id = excluded.household_id`,
      )
      .bind(opts.telegramId, opts.householdId, createdAt),
  ]);
}

function toMember(r: MemberRow): Member {
  return { telegramId: r.telegram_id, householdId: r.household_id, displayName: r.display_name, role: r.role };
}
