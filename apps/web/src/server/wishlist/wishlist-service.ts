/**
 * Wishlist: a customer's saved-for-later products.
 *
 * `toggleWishlist` is the one real entry point the UI needs — add-if-absent,
 * remove-if-present — made idempotent-safe under a concurrent double-click
 * by the real `@@unique([userId, productId])` constraint (see schema.prisma's
 * own comment), not an application-level check-then-write.
 *
 * `listWishlist` deliberately does NOT filter out a product that's gone
 * out of stock, been unpublished, or whose seller was suspended — a real
 * wishlist should say "no longer available", not silently make the item
 * disappear as if the customer never saved it. The UI decides what to show
 * based on the product/seller status this returns, same as
 * catalogue-service.ts's VISIBLE_PRODUCT_WHERE is applied at browse/search
 * time, not baked into this query.
 */

import { prisma } from "../db.js";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export interface ToggleResult {
  readonly wishlisted: boolean;
}

export async function toggleWishlist(userId: string, productId: string): Promise<ToggleResult> {
  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_productId: { userId, productId } },
  });

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });
    return { wishlisted: false };
  }

  try {
    await prisma.wishlistItem.create({ data: { userId, productId } });
    return { wishlisted: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent request already added it — still a real "wishlisted" outcome.
      return { wishlisted: true };
    }
    throw error;
  }
}

export async function isWishlisted(userId: string, productId: string): Promise<boolean> {
  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_productId: { userId, productId } },
    select: { id: true },
  });
  return existing !== null;
}

export async function listWishlist(userId: string) {
  return prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      product: {
        include: {
          seller: { select: { slug: true, storeName: true, status: true } },
          variants: { where: { active: true }, orderBy: { position: "asc" }, include: { inventory: true } },
          images: { orderBy: { position: "asc" }, take: 1 },
        },
      },
    },
  });
}
