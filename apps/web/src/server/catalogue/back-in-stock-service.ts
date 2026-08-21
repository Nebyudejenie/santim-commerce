/**
 * Back-in-stock requests — scoped to a VARIANT, not the product: a
 * sold-out size/color is what a real customer is actually waiting on (see
 * AddToCartForm's own per-variant stock display), not the product as a
 * whole.
 *
 * Domain logic only — the actual notification-creation lives in
 * notification-service.ts's `notifyBackInStock`, consistent with every
 * other `notifyX` function in this codebase living there, not scattered
 * across each domain that triggers one.
 */

import { prisma } from "../db.js";
import { enqueue } from "../outbox.js";
import { totalAvailable } from "./catalogue-service.js";
import type { Tx } from "../db.js";

export class BackInStockError extends Error {
  override name = "BackInStockError";
}

export async function requestBackInStockNotification(userId: string, variantId: string): Promise<void> {
  const variant = await prisma.variant.findUnique({ where: { id: variantId }, include: { inventory: true } });
  if (!variant) {
    throw new BackInStockError("Item not found.");
  }
  if (totalAvailable(variant.inventory) > 0) {
    throw new BackInStockError("This item is already in stock.");
  }

  // A real upsert: a first-time request creates the row; a customer who
  // was already notified once and wants another heads-up for a later
  // stockout re-arms the SAME row rather than creating a duplicate — see
  // the model's own @@unique([userId, variantId]).
  await prisma.backInStockRequest.upsert({
    where: { userId_variantId: { userId, variantId } },
    create: { userId, variantId },
    update: { notifiedAt: null },
  });
}

export async function hasRequestedBackInStock(userId: string, variantId: string): Promise<boolean> {
  const request = await prisma.backInStockRequest.findUnique({
    where: { userId_variantId: { userId, variantId } },
    select: { notifiedAt: true },
  });
  return request !== null && request.notifiedAt === null;
}

/** Bulk lookup for a PDP's whole variant list — one query, not one per
 * variant, same reasoning as wishlist-service.ts's listWishlistedProductIds. */
export async function listPendingRequestedVariantIds(userId: string, variantIds: readonly string[]): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  const rows = await prisma.backInStockRequest.findMany({
    where: { userId, variantId: { in: [...variantIds] }, notifiedAt: null },
    select: { variantId: true },
  });
  return new Set(rows.map((r) => r.variantId));
}

/**
 * Call after ANY inventory-increasing write, inside the SAME transaction —
 * side effects still go through the outbox, never a direct notification
 * call, same discipline as every other outbox producer in this codebase.
 * Cheap no-op when the variant isn't actually available yet, or has no
 * pending requests at all. Deliberately NOT gated on "was this variant
 * exactly zero before this specific update" — see notification-service.ts's
 * `notifyBackInStock`, whose own `notifiedAt IS NULL` filter is the real
 * idempotency guard, so an extra enqueue here for an unrelated stock bump
 * is at worst a cheap, correctly-no-op'd query, never a duplicate notification.
 */
export async function enqueueBackInStockCheck(tx: Tx, variantId: string): Promise<void> {
  const inventory = await tx.inventory.findUnique({ where: { variantId } });
  if (totalAvailable(inventory) <= 0) return;

  const hasPendingRequests = await tx.backInStockRequest.findFirst({
    where: { variantId, notifiedAt: null },
    select: { id: true },
  });
  if (!hasPendingRequests) return;

  await enqueue(tx, "variant.restocked", { variantId });
}
