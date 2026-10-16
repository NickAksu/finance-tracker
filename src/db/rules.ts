import type { RuleRef } from "../domain/normalize";

export async function listRules(db: D1Database, householdId: number): Promise<RuleRef[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.match_type, r.pattern, r.category_id FROM category_rules r
       JOIN categories c ON c.id = r.category_id
       WHERE r.household_id = ? AND c.archived_at IS NULL`,
    )
    .bind(householdId)
    .all<{ id: number; match_type: RuleRef["matchType"]; pattern: string; category_id: number }>();
  return results.map((r) => ({ id: r.id, matchType: r.match_type, pattern: r.pattern, categoryId: r.category_id }));
}

export function incrementRuleHitsStatement(db: D1Database, householdId: number, ruleIds: number[]): D1PreparedStatement | null {
  if (ruleIds.length === 0) return null;
  return db
    .prepare(`UPDATE category_rules SET hits = hits + 1 WHERE household_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(householdId, JSON.stringify(ruleIds));
}
