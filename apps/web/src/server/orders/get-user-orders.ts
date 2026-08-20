import { prisma } from "../db.js";

/** A customer's own order history — never used for the admin view (see admin-queries.ts). */
export async function getOrdersForUser(userId: string) {
  return prisma.order.findMany({
    where: { userId },
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
      lines: true,
      payments: {
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, channel: true, channelRef: true, completedAt: true },
      },
    },
  });
}
