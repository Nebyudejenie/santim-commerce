/**
 * Seller-facing order queries — "what have I sold." Split from
 * get-user-orders.ts (the buyer's own view) and admin-queries.ts (staff's
 * platform-wide view) for the same reason those are already split from
 * each other: different audience, different authorization boundary,
 * different shape. A seller sees buyer contact/shipping details (they need
 * them to actually ship the item — real fulfillment requires this), but
 * never another seller's line items, payment internals, or gateway
 * transaction ids.
 *
 * Only orders that actually resolved to a real transaction are shown —
 * PENDING_PAYMENT (might never complete) and FAILED/CANCELLED (never
 * became a real sale) are excluded. A seller finding out about an order
 * before it's actually paid for is a false signal, not useful information.
 */

import type { FulfilmentStatus } from "@prisma/client";
import { prisma } from "../db.js";

const SOLD_ORDER_STATUSES = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] as const;

export interface SellerOrderFilter {
  readonly fulfilmentStatus?: FulfilmentStatus;
  /** Matches an order number or the buyer's checkout email — confirmed
   * absent before this: a seller with more than `take` sales had no way
   * to find an older or specific one at all. */
  readonly search?: string;
}

export async function listSellerOrderLines(sellerId: string, filter: SellerOrderFilter = {}, take = 100) {
  return prisma.orderLine.findMany({
    where: {
      sellerId,
      ...(filter.fulfilmentStatus ? { fulfilmentStatus: filter.fulfilmentStatus } : {}),
      order: {
        status: { in: [...SOLD_ORDER_STATUSES] },
        ...(filter.search
          ? {
              OR: [
                { orderNumber: { contains: filter.search, mode: "insensitive" } },
                { email: { contains: filter.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
    },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      order: {
        select: {
          orderNumber: true,
          status: true,
          fulfilmentStatus: true,
          email: true,
          phone: true,
          shippingAddress: true,
          placedAt: true,
          paidAt: true,
        },
      },
    },
  });
}

/** Returns null (not a throw) for an order this seller has no line in — see
 * this module's own comment on why a seller never sees another seller's
 * order detail, not even the buyer contact info of an order they had zero
 * part in. */
export async function getSellerOrderDetail(sellerId: string, orderNumber: string) {
  const lines = await prisma.orderLine.findMany({
    where: { sellerId, order: { orderNumber } },
    orderBy: { createdAt: "asc" },
  });
  if (lines.length === 0) return null;

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: {
      orderNumber: true,
      status: true,
      fulfilmentStatus: true,
      userId: true,
      email: true,
      phone: true,
      shippingAddress: true,
      customerNote: true,
      placedAt: true,
      paidAt: true,
    },
  });
  if (!order) return null;

  return { order, lines };
}
