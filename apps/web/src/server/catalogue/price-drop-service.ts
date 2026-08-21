/**
 * Wishlist price-drop alerts — confirmed absent before this: a product's
 * price could fall after a buyer wishlisted it with zero real-time
 * signal, only whatever they happened to notice next time they revisited
 * the page. Mechanically the seller-side mirror of back-in-stock-service.ts
 * (a per-recipient "interest" row — here WishlistItem doubles as that row,
 * no separate request table needed) and low-stock-service.ts (the
 * transactional trigger site).
 *
 * Domain logic only — the actual notification-creation lives in
 * notification-service.ts's `notifyPriceDrop`, consistent with every
 * other `notifyX` function in this codebase living there.
 */

import type { Tx } from "../db.js";
import { enqueue } from "../outbox.js";

/**
 * Call after a REAL price decrease, inside the SAME transaction as the
 * variant update — see listing-service.ts's `updateVariant`, and
 * outbox.ts's own comment on why side effects never happen synchronously
 * inside that same transaction. Unconditional (the caller already
 * confirmed the price actually dropped) — the real "did this ACTUALLY
 * drop below what any wishlister was last notified at" comparison
 * happens once, at delivery time, in `notifyPriceDrop` itself, the same
 * "re-check at delivery, not just at enqueue" discipline
 * back-in-stock-service.ts's own consumer already uses.
 */
export async function enqueuePriceDropCheck(tx: Tx, productId: string): Promise<void> {
  await enqueue(tx, "product.price_dropped", { productId });
}
