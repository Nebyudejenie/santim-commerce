import { prisma } from "../db.js";

/** Minimal, public-safe projection — no email/address/line items exposed. */
export async function getOrderStatus(orderNumber: string) {
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { orderNumber: true, status: true, totalSantim: true, paidAt: true },
  });
  return order;
}

export async function getOrderForStatusPage(orderNumber: string) {
  return prisma.order.findUnique({
    where: { orderNumber },
    select: {
      orderNumber: true,
      status: true,
      email: true,
      totalSantim: true,
      paidAt: true,
      placedAt: true,
      payments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { failureMessage: true, channel: true, status: true },
      },
    },
  });
}
