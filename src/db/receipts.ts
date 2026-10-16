import type { NormalizedReceipt } from "../domain/normalize";
import { nowIso } from "../lib/time";
import { incrementRuleHitsStatement } from "./rules";

export type ReceiptStatus = "processing" | "draft" | "confirmed" | "failed";
export type ReceiptDocType = "store_receipt" | "erip" | "online_order" | "manual";
export type ReceiptSource = "photo" | "pdf" | "text" | "miniapp";

export interface ReceiptFileRef {
  tgFileId: string;
  tgFileUniqueId: string;
  mime: string;
}

export interface ReceiptHeader {
  id: number;
  householdId: number;
  addedBy: number;
  addedByName: string;
  chatId: number;
  messageId: number | null;
  storeName: string | null;
  purchasedAt: string;
  totalMinor: number;
  currency: string;
  docType: ReceiptDocType;
  eripAccount: string | null;
  status: ReceiptStatus;
  hasSumMismatch: boolean;
  confidence: string | null;
}

export interface CategoryTotal {
  categoryId: number;
  emoji: string;
  name: string;
  totalMinor: number;
  itemCount: number;
}

interface ReceiptRow {
  id: number;
  household_id: number;
  added_by: number;
  added_by_name: string | null;
  chat_id: number;
  message_id: number | null;
  store_name: string | null;
  purchased_at: string;
  total_minor: number;
  currency: string;
  doc_type: ReceiptDocType;
  erip_account: string | null;
  status: ReceiptStatus;
  has_sum_mismatch: number;
  confidence: string | null;
}

const HEADER_SQL = `
  SELECT r.id, r.household_id, r.added_by, m.display_name AS added_by_name, r.chat_id, r.message_id,
         r.store_name, r.purchased_at, r.total_minor, r.currency, r.doc_type, r.erip_account,
         r.status, r.has_sum_mismatch, r.confidence
  FROM receipts r LEFT JOIN members m ON m.telegram_id = r.added_by`;

export async function getReceipt(db: D1Database, householdId: number, receiptId: number): Promise<ReceiptHeader | null> {
  const row = await db
    .prepare(`${HEADER_SQL} WHERE r.id = ? AND r.household_id = ?`)
    .bind(receiptId, householdId)
    .first<ReceiptRow>();
  return row && toHeader(row);
}

/** Чек, в котором уже есть один из этих файлов (повторно присланное фото). */
export async function findReceiptByFiles(
  db: D1Database,
  householdId: number,
  fileUniqueIds: string[],
): Promise<ReceiptHeader | null> {
  if (fileUniqueIds.length === 0) return null;
  const row = await db
    .prepare(
      `${HEADER_SQL}
       WHERE r.household_id = ?1 AND r.id IN (
         SELECT receipt_id FROM receipt_files
         WHERE household_id = ?1 AND tg_file_unique_id IN (SELECT value FROM json_each(?2)))
       LIMIT 1`,
    )
    .bind(householdId, JSON.stringify(fileUniqueIds))
    .first<ReceiptRow>();
  return row && toHeader(row);
}

/** Возможный дубликат: тот же итог в те же сутки (±12 ч) и, если известен, тот же магазин. */
export async function findSimilarReceipt(
  db: D1Database,
  receipt: { householdId: number; id: number; storeName: string | null; purchasedAt: string; totalMinor: number },
): Promise<ReceiptHeader | null> {
  const t = new Date(receipt.purchasedAt).getTime();
  const from = new Date(t - 12 * 3_600_000).toISOString();
  const to = new Date(t + 12 * 3_600_000).toISOString();
  const row = await db
    .prepare(
      `${HEADER_SQL}
       WHERE r.household_id = ? AND r.purchased_at BETWEEN ? AND ? AND r.total_minor = ? AND r.id != ?
         AND (? IS NULL OR r.store_name IS NULL OR lower(r.store_name) = lower(?))
       ORDER BY r.id LIMIT 1`,
    )
    .bind(receipt.householdId, from, to, receipt.totalMinor, receipt.id, receipt.storeName, receipt.storeName)
    .first<ReceiptRow>();
  return row && toHeader(row);
}

export async function getCategoryTotals(db: D1Database, receiptId: number): Promise<CategoryTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.emoji, c.name, sum(i.total_minor) AS total, count(*) AS n
       FROM items i JOIN categories c ON c.id = i.category_id
       WHERE i.receipt_id = ?
       GROUP BY c.id ORDER BY total DESC`,
    )
    .bind(receiptId)
    .all<{ id: number; emoji: string; name: string; total: number; n: number }>();
  return results.map((r) => ({ categoryId: r.id, emoji: r.emoji, name: r.name, totalMinor: r.total, itemCount: r.n }));
}

/**
 * Сохраняет распознанный чек черновиком. Шапка вставляется первой (нужен id),
 * позиции, файлы и счётчики правил — одной транзакцией; при её сбое шапка удаляется.
 * Если файл уже привязан к чеку (гонка двух одинаковых фото), возвращает null.
 */
export async function insertParsedReceipt(
  db: D1Database,
  opts: {
    householdId: number;
    addedBy: number;
    chatId: number;
    messageId: number | null;
    source: ReceiptSource;
    receipt: NormalizedReceipt;
    files: ReceiptFileRef[];
    aiModel: string;
    rawJson: string;
  },
): Promise<number | null> {
  const r = opts.receipt;
  const now = nowIso();
  const header = await db
    .prepare(
      `INSERT INTO receipts (household_id, added_by, chat_id, message_id, store_name, purchased_at, total_minor, currency,
         source, doc_type, erip_account, status, has_sum_mismatch, confidence, ai_model, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      opts.householdId, opts.addedBy, opts.chatId, opts.messageId, r.storeName, r.purchasedAt, r.totalMinor, r.currency,
      opts.source, r.docType, r.eripAccount, r.hasSumMismatch ? 1 : 0, r.confidence, opts.aiModel, opts.rawJson, now, now,
    )
    .first<{ id: number }>();
  if (!header) throw new Error("Не удалось сохранить чек");

  const itemStmt = db.prepare(
    `INSERT INTO items (receipt_id, position, name, quantity, total_minor, discount_minor, category_id, category_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fileStmt = db.prepare(
    `INSERT INTO receipt_files (receipt_id, household_id, position, tg_file_id, tg_file_unique_id, mime)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const hits = incrementRuleHitsStatement(db, opts.householdId, r.appliedRuleIds);
  try {
    await db.batch([
      ...r.items.map((i) =>
        itemStmt.bind(header.id, i.position, i.name, i.quantity, i.totalMinor, i.discountMinor, i.categoryId, i.categorySource),
      ),
      ...opts.files.map((f, idx) => fileStmt.bind(header.id, opts.householdId, idx + 1, f.tgFileId, f.tgFileUniqueId, f.mime)),
      ...(hits ? [hits] : []),
    ]);
  } catch (e) {
    await db.prepare("DELETE FROM receipts WHERE id = ?").bind(header.id).run();
    if (String(e).includes("UNIQUE constraint failed: receipt_files")) return null;
    throw e;
  }
  return header.id;
}

export async function setReceiptStatus(
  db: D1Database,
  householdId: number,
  receiptId: number,
  status: ReceiptStatus,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE receipts SET status = ?, updated_at = ? WHERE id = ? AND household_id = ?")
    .bind(status, nowIso(), receiptId, householdId)
    .run();
  return res.meta.changes > 0;
}

export async function setReceiptMessage(db: D1Database, householdId: number, receiptId: number, messageId: number): Promise<void> {
  await db
    .prepare("UPDATE receipts SET message_id = ? WHERE id = ? AND household_id = ?")
    .bind(messageId, receiptId, householdId)
    .run();
}

export async function deleteReceipt(db: D1Database, householdId: number, receiptId: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM receipts WHERE id = ? AND household_id = ?").bind(receiptId, householdId).run();
  return res.meta.changes > 0;
}

function toHeader(r: ReceiptRow): ReceiptHeader {
  return {
    id: r.id,
    householdId: r.household_id,
    addedBy: r.added_by,
    addedByName: r.added_by_name ?? "участник",
    chatId: r.chat_id,
    messageId: r.message_id,
    storeName: r.store_name,
    purchasedAt: r.purchased_at,
    totalMinor: r.total_minor,
    currency: r.currency,
    docType: r.doc_type,
    eripAccount: r.erip_account,
    status: r.status,
    hasSumMismatch: r.has_sum_mismatch === 1,
    confidence: r.confidence,
  };
}
