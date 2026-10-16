export interface Category {
  id: number;
  code: string;
  name: string;
  emoji: string;
  color: string;
  description: string | null;
  isSystem: boolean;
}

export async function listActiveCategories(db: D1Database, householdId: number): Promise<Category[]> {
  const { results } = await db
    .prepare(
      `SELECT id, code, name, emoji, color, description, is_system FROM categories
       WHERE household_id = ? AND archived_at IS NULL ORDER BY sort_order, id`,
    )
    .bind(householdId)
    .all<{ id: number; code: string; name: string; emoji: string; color: string; description: string | null; is_system: number }>();
  return results.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    emoji: r.emoji,
    color: r.color,
    description: r.description,
    isSystem: r.is_system === 1,
  }));
}
