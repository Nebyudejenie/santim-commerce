import { prisma } from "../db.js";

/**
 * A customer's own order history — never used for the admin view (see
 * admin-queries.ts). `search` matches either the order number or a
 * product title on one of its lines — confirmed absent before this: a
 * customer with many orders had no way to find one at all, and "the blue
 * jacket" is often easier to remember than an order number.
 */
export async function getOrdersForUser(userId: string, search?: string) {
  return prisma.order.findMany({
    where: {
      userId,
      ...(search
        ? {
            OR: [
              { orderNumber: { contains: search, mode: "insensitive" } },
              { lines: { some: { productTitle: { contains: search, mode: "insensitive" } } } },
            ],
          }
        : {}),
    },
    orderBy: { placedAt: "desc" },
    select: {
      orderNumber: true,
      status: true,
      fulfilmentStatus: true,
      totalSantim: true,
      placedAt: true,
      lines: { select: { productTitle: true, variantTitle: true, quantity: true, imageUrl: true } },
    },
  });
}

/** A single order, scoped to its owner — must never return another user's order. */
export async function getOrderForUser(userId: string, orderNumber: string) {
  return prisma.order.findFirst({
    where: { orderNumber, userId },
    include: {
      lines: { include: { returnRequest: true } },
      payments: {
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, channel: true, channelRef: true, completedAt: true },
      },
    },
  });
}
