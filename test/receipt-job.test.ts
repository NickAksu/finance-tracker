import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold } from "../src/db/households";
import { handleReceiptJob } from "../src/jobs/receipt-job";
import { RETRY_DELAY_SECONDS, type ReceiptJob } from "../src/jobs/types";
import { mockFetch, OWNER } from "./helpers/telegram";

const TABLES = [
  "items", "receipt_files", "receipts", "category_rules", "categories", "invites", "chats", "members", "households",
  "processed_updates", "media_group_parts", "media_groups",
];

beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => vi.restoreAllMocks());

const receiptJson = JSON.stringify({
  doc_type: "store_receipt",
  store_name: "Евроопт",
  purchased_at: "2026-10-05T14:32",
  currency: "BYN",
  erip_account: null,
  items: [{ name: "Хлеб", quantity: 1, price: 1.99, discount: 0, line_total: 1.99, category: "groceries" }],
  fee_amount: 0,
  total_amount: 1.99,
  confidence: "high",
  reason: null,
});

const geminiOk = () => Response.json({ candidates: [{ content: { parts: [{ text: receiptJson }] }, finishReason: "STOP" }] });
const gemini429 = () => Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }, { status: 429 });

async function receiptJob(attempt?: number): Promise<Extract<ReceiptJob, { type: "receipt" }>> {
  const household = await createHousehold(env.DB, { ownerId: OWNER.id, ownerName: "Ник", timezone: "Europe/Minsk", currency: "BYN" });
  return {
    type: "receipt",
    householdId: household.id,
    chatId: OWNER.id,
    addedBy: OWNER.id,
    statusMessageId: 77,
    source: "photo",
    files: [{ tgFileId: "file-1", tgFileUniqueId: "uniq-1", mime: "image/jpeg" }],
    ...(attempt ? { attempt } : {}),
  };
}

/** Gemini упирается в лимит, запасной Workers AI падает — оба движка недоступны. */
function bothEnginesDown() {
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI unavailable"));
  return mockFetch(() => gemini429());
}

const receiptCount = () => env.DB.prepare("SELECT count(*) AS n FROM receipts").first<number>("n");

describe("handleReceiptJob", () => {
  it("успех: чек сохранён, «⏳» превращается в сводку", async () => {
    const job = await receiptJob();
    const tg = mockFetch(() => geminiOk());
    const send = vi.spyOn(env.RECEIPT_QUEUE, "send");

    await handleReceiptJob(env, job);

    expect(await receiptCount()).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const edit = tg.calls.find((c) => c.method === "editMessageText")!;
    expect(edit.body.message_id).toBe(77);
    expect(edit.body.text).toContain("Евроопт");
  });

  it("временный сбой обоих движков → повтор через минуту с теми же файлами", async () => {
    const job = await receiptJob();
    const tg = bothEnginesDown();
    const send = vi.spyOn(env.RECEIPT_QUEUE, "send").mockResolvedValue(undefined as never);

    await handleReceiptJob(env, job);

    expect(await receiptCount()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ ...job, attempt: 2 }, { delaySeconds: RETRY_DELAY_SECONDS });
    const edit = tg.calls.find((c) => c.method === "editMessageText")!;
    expect(edit.body.message_id).toBe(77);
    expect(edit.body.text).toContain("через минуту");
  });

  it("последняя попытка: без повтора, понятная ошибка", async () => {
    const job = await receiptJob(2);
    const tg = bothEnginesDown();
    const send = vi.spyOn(env.RECEIPT_QUEUE, "send");

    await handleReceiptJob(env, job);

    expect(send).not.toHaveBeenCalled();
    const edit = tg.calls.find((c) => c.method === "editMessageText")!;
    expect(edit.body.text).toContain("Попробуйте");
    expect(edit.body.text).not.toContain("через минуту");
  });

  it("очередь недоступна → сразу сообщение об ошибке", async () => {
    const job = await receiptJob();
    const tg = bothEnginesDown();
    vi.spyOn(env.RECEIPT_QUEUE, "send").mockRejectedValue(new Error("queue down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await handleReceiptJob(env, job);

    const texts = tg.calls.filter((c) => c.method === "editMessageText").map((c) => c.body.text as string);
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toContain("через минуту");
  });

  it("альбом при сбое повторяется обычным заданием с файлами альбома", async () => {
    const { householdId } = await receiptJob();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO media_groups (media_group_id, household_id, chat_id, added_by, status_message_id, created_at) VALUES ('mg1', ?, ?, ?, 55, '')",
      ).bind(householdId, OWNER.id, OWNER.id),
      env.DB.prepare(
        "INSERT INTO media_group_parts (media_group_id, message_id, tg_file_id, tg_file_unique_id, mime, created_at) VALUES ('mg1', 1, 'f1', 'u1', 'image/jpeg', ''), ('mg1', 2, 'f2', 'u2', 'image/jpeg', '')",
      ),
    ]);
    bothEnginesDown();
    const send = vi.spyOn(env.RECEIPT_QUEUE, "send").mockResolvedValue(undefined as never);

    await handleReceiptJob(env, { type: "album", mediaGroupId: "mg1" });

    const [retry] = send.mock.calls[0]!;
    expect(retry).toMatchObject({ type: "receipt", householdId, statusMessageId: 55, attempt: 2 });
    expect((retry as Extract<ReceiptJob, { type: "receipt" }>).files.map((f) => f.tgFileUniqueId)).toEqual(["u1", "u2"]);
  });
});
