/**
 * Self-service data export — the natural companion to self-service
 * account deletion (auth-service.ts's `deleteOwnAccount`): a real,
 * standard right on virtually every comparable platform, confirmed
 * genuinely absent before this. Read-only, scoped entirely to the
 * calling user's own id — every query below filters on it directly,
 * never trusting anything else.
 */

import { prisma } from "../db.js";

export async function exportUserData(userId: string) {
  const [user, addresses, orders, reviews, wishlist, questionsAsked] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true },
    }),
    prisma.address.findMany({ where: { userId } }),
    prisma.order.findMany({
      where: { userId },
      orderBy: { placedAt: "desc" },
      include: { lines: true },
    }),
    prisma.productReview.findMany({ where: { userId } }),
    prisma.wishlistItem.findMany({ where: { userId }, include: { product: { select: { title: true, slug: true } } } }),
    prisma.productQuestion.findMany({
      where: { askedByUserId: userId },
      select: { id: true, question: true, answer: true, createdAt: true, product: { select: { title: true, slug: true } } },
    }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    profile: user,
    addresses,
    orders,
    reviews,
    wishlist,
    questionsAsked,
  };
}
