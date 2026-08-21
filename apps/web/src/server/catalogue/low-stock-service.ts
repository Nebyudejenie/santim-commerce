/**
 * Seller-facing low-stock alerts.
 *
 * `Inventory.lowStockThreshold` already existed — its own schema comment
 * promised "the storefront shows 'only N left'" — but was completely
 * unused anywhere in the codebase: the storefront hardcoded its own
 * `<= 5` instead of reading it, and no seller notification existed at
 * all. This is the fix for the seller side; add-to-cart-form.tsx/the
 * product page are the fix for the storefront side.
 *
 * Domain logic only — the actual notification-creation lives in
 * notification-service.ts's `notifyLowStock`, consistent with every other
 * `notifyX` function in this codebase living there, not scattered across
 * each domain that triggers one. This is that module's first SELLER-
 * facing notification; every prior one notified a customer.
 */

import type { Tx } from "../db.js";
import { enqueue } from "../outbox.js";

/**
 * Call after ANY inventory-decreasing write, inside the SAME transaction —
 * side effects still go through the outbox, never a direct notification
 * call, same discipline as every other outbox producer in this codebase.
 *
 * Re-arm design mirrors back-in-stock-service.ts's own
 * `enqueueBackInStockCheck`, but simpler: there's no per-recipient
 * request row (a seller doesn't opt in to alerts about their own stock),
 * just a per-variant "are we currently in an alerted dip" flag
 * (`lowStockAlertedAt`) and a monotonic counter (`lowStockAlertCount`)
 * that feeds the notification's dedupeKey — see schema.prisma's own
 * comment on why resetting the FLAG on recovery must never reset the
 * COUNT too.
 */
export async function enqueueLowStockCheck(tx: Tx, variantId: string): Promise<void> {
  const inventory = await tx.inventory.findUnique({ where: { variantId } });
  if (!inventory) return;

  const available = inventory.onHand - inventory.reserved;

  if (available > inventory.lowStockThreshold) {
    // Stock recovered — re-arm for the next real dip, if it was alerted.
    if (inventory.lowStockAlertedAt) {
      await tx.inventory.update({ where: { variantId }, data: { lowStockAlertedAt: null } });
    }
    return;
  }

  if (inventory.lowStockAlertedAt) return; // already alerted for this dip — no-op

  const updated = await tx.inventory.update({
    where: { variantId },
    data: { lowStockAlertedAt: new Date(), lowStockAlertCount: { increment: 1 } },
  });

  await enqueue(tx, "variant.low_stock", { variantId, alertCount: updated.lowStockAlertCount });
}
