// Промпт распознавания. Инструкции на английском (компактнее по токенам),
// значения (названия позиций, магазин) — на языке документа.

import type { ParseContext } from "./types";

/** Локальные дата и время "YYYY-MM-DD HH:mm" в часовом поясе семьи. */
export function localNow(now: Date, timezone: string): string {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function buildPrompt(ctx: ParseContext, fileCount = 1): string {
  const codes = new Set(ctx.categories.map((c) => c.code));
  const bagsTo = codes.has("groceries") ? "groceries" : "the main category of the receipt";
  const categories = ctx.categories
    .map((c) => `- ${c.code}: ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n");

  return `You extract purchase data for a family expense tracker in Belarus from a photo, screenshot or PDF. Reply with JSON matching the schema.
Now: ${localNow(ctx.now, ctx.timezone)} (${ctx.timezone}). Default currency: ${ctx.currency}.
${fileCount > 1 ? `There are ${fileCount} images of ONE document (a long receipt shot in parts or one order over several screenshots): merge them into one result; parts overlap — never duplicate a line seen twice.\n` : ""}
DOC TYPE (doc_type):
- store_receipt: cash register receipt of a shop, cafe, pharmacy, fuel station (paper photo or e-receipt PDF).
- erip: payment via ЕРИП/ERIP (bank app or payment receipt: utilities, phone, internet, fines, etc.).
- online_order: PAID online order (Wildberries, Ozon, Kufar, other e-shops).
- not_purchase: shopping cart, unpaid / awaiting-payment order, price list, menu, random photo, unreadable image. Then items=[], total_amount=null and reason = short explanation in Russian.

GENERAL:
- Keep item and store names in the document's language, as printed (fix only obvious line breaks). Do not translate.
- total_amount = amount actually charged, INCLUDING any commission / service fee.
- fee_amount = commission (комиссия) or service fee (сервисный сбор); it is NOT an item and NOT included in items; 0 if none.
- Each item: quantity, price per unit, discount (positive number, 0 if none), line_total = amount after discount, category code.
- purchased_at: date/time printed on the document (local time), "YYYY-MM-DDTHH:mm", or "YYYY-MM-DD" if no time, null if absent. Use "Now" to resolve year-less or relative dates ("сегодня", "вчера").
- currency: ISO code; "руб.", "р.", "BYN" → BYN. Use null if not shown.
- Numbers are plain JSON numbers with a dot (12.5, not "12,50").
- confidence: high = fully legible and items sum to the total; medium = minor doubts; low = blurry, cut off or guessed.

STORE RECEIPT:
- store_name: shop brand (Евроопт, Санта, Корона, Белфармация, Гиппо…) rather than legal entity (ООО/ОДО/ЗАО) if visible.
- Weighted goods: quantity = weight (e.g. 0.532), price = per kg.
- A "Скидка"/"Акция"/discount line under an item belongs to that item: put it into its discount and reduce line_total. A receipt-wide discount → apply to the largest item.
- Bags, packaging (пакет, тара) are items with category ${bagsTo}.
- Skip non-item lines: НДС, ИТОГО/ВСЕГО, сдача, оплата картой/наличными, бонусы начислено/списано, card and terminal data.
- total_amount = final "ИТОГО"/"К ОПЛАТЕ".

ERIP:
- store_name = service provider / recipient (e.g. МТС, А1, ЖЭС, Минскэнерго…).
- Usually one item = the paid service, line_total = payment amount without commission. If there is a breakdown (отопление, вода, электроэнергия…) each line is a separate item.
- erip_account = лицевой счёт / номер договора / phone number identifying the payer, as printed.
- total_amount = amount debited including commission.

ONLINE ORDER:
- store_name = marketplace or shop name.
- total_amount = "Оплачено" / "К оплате" / "Итого" AFTER promo codes, points and discounts. Ignore strikethrough (old) prices.
- Item line_total = price actually paid for the item. Delivery (доставка), if charged, is a separate item.
- purchased_at = payment/order date, not the delivery date.

CATEGORIES (category = code; pick the closest; if nothing fits use "other"):
${categories}`;
}
