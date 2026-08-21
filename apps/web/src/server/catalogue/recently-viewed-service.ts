/**
 * Recently viewed products — signed-in users only, matching the
 * established convention in this codebase (wishlist, notifications) that
 * engagement/tracking features need an account; there's no cookie-based
 * guest tracking here.
 *
 * `recordView` is a real, deliberate exception to "GET requests should be
 * side-effect-free": recording a page view is a universal, accepted
 * exception across the real web (analytics, view counters, recommendation
 * engines all do this), and the write itself is a single, fast upsert on
 * a real unique constraint — a repeat view of the same product updates
 * `viewedAt` in place, it never grows an unbounded per-view log.
 */

import { prisma } from "../db.js";
import { VISIBLE_PRODUCT_WHERE } from "./catalogue-service.js";

export async function recordView(userId: string, productId: string): Promise<void> {
  // The upsert alone establishes/touches viewedAt; the raw statement right
  // after is what actually fixes ordering — see RecentlyViewed.touchSeq's
  // own schema comment for why viewedAt/id can't safely do this on their
  // own. nextval() runs on EVERY view, create or update, so touchSeq is a
  // real, DB-level monotonic "last touched" counter.
  await prisma.$transaction([
    prisma.recentlyViewed.upsert({
      where: { userId_productId: { userId, productId } },
      create: { userId, productId },
      update: { viewedAt: new Date() },
    }),
    prisma.$executeRaw`
      UPDATE "recently_viewed"
      SET "touchSeq" = nextval('recently_viewed_touch_seq')
      WHERE "userId" = ${userId} AND "productId" = ${productId}
    `,
  ]);
}

/**
 * Filtered to currently-visible products (VISIBLE_PRODUCT_WHERE) — unlike
 * the wishlist, which deliberately keeps showing an item that's gone
 * unavailable because saving it was a deliberate signal, a passively
 * recorded view of something no longer buyable isn't worth surfacing.
 */
export async function listRecentlyViewed(userId: string, excludeProductId?: string, take = 8) {
  return prisma.recentlyViewed.findMany({
    where: {
      userId,
      productId: excludeProductId ? { not: excludeProductId } : undefined,
      product: VISIBLE_PRODUCT_WHERE,
    },
    // touchSeq, not viewedAt/id — see recordView and the model's own
    // comment for why those can't safely order "most recently touched".
    orderBy: [{ touchSeq: "desc" }],
    take,
    include: {
      product: {
        include: {
          variants: { where: { active: true }, orderBy: { position: "asc" }, include: { inventory: true } },
          images: { orderBy: { position: "asc" }, take: 1 },
        },
      },
    },
  });
}
