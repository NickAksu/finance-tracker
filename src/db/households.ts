import { DEFAULT_CATEGORIES } from "../domain/categories";
import { nowIso } from "../lib/time";

export interface Household {
  id: number;
  name: string;
  timezone: string;
  currency: string;
}

interface HouseholdRow {
  id: number;
  name: string;
  timezone: string;
  currency: string;
}

export async function getHousehold(db: D1Database, id: number): Promise<Household | null> {
  return db
    .prepare("SELECT id, name, timezone, currency FROM households WHERE id = ?")
    .bind(id)
    .first<HouseholdRow>();
}

/**
 * Новая семья: владелец, стандартные категории и его личный чат.
 * Сначала создаётся семья (нужен id), остальное — одной транзакцией.
 */
export async function createHousehold(
  db: D1Database,
  opts: { ownerId: number; ownerName: string; timezone: string; currency: string },
): Promise<Household> {
  const createdAt = nowIso();
  const household = await db
    .prepare("INSERT INTO households (timezone, currency, created_at) VALUES (?, ?, ?) RETURNING id, name, timezone, currency")
    .bind(opts.timezone, opts.currency, createdAt)
    .first<HouseholdRow>();
  if (!household) throw new Error("Не удалось создать семью");

  await db.batch([
    db
      .prepare("INSERT INTO members (telegram_id, household_id, display_name, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
      .bind(opts.ownerId, household.id, opts.ownerName, createdAt),
    db
      .prepare("INSERT INTO chats (chat_id, household_id, type, created_at) VALUES (?, ?, 'private', ?)")
      .bind(opts.ownerId, household.id, createdAt),
    ...seedCategoryStatements(db, household.id),
  ]);
  return household;
}

export function seedCategoryStatements(db: D1Database, householdId: number): D1PreparedStatement[] {
  const stmt = db.prepare(
    `INSERT INTO categories (household_id, code, name, emoji, color, description, sort_order, is_system)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return DEFAULT_CATEGORIES.map((c, i) =>
    stmt.bind(householdId, c.code, c.name, c.emoji, c.color, c.description, (i + 1) * 10, c.isSystem ? 1 : 0),
  );
}

/** Семья пустая: один участник и ни одного чека. Такую можно бросить при входе по инвайту. */
export async function isHouseholdDisposable(db: D1Database, householdId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT (SELECT count(*) FROM members WHERE household_id = ?1) AS members,
              (SELECT count(*) FROM receipts WHERE household_id = ?1) AS receipts`,
    )
    .bind(householdId)
    .first<{ members: number; receipts: number }>();
  return !!row && row.members <= 1 && row.receipts === 0;
}

export async function deleteEmptyHousehold(db: D1Database, householdId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM category_rules WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM categories WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM chats WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM invites WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM members WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM households WHERE id = ?").bind(householdId),
  ]);
}
