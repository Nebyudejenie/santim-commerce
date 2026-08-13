/**
 * Read-side catalogue queries.
 *
 * Kept separate from any future write/admin path: browsing traffic is
 * orders-of-magnitude higher than catalogue edits, and this is where a
 * caching layer (Phase 11 in the curriculum) gets added first. Isolating the
 * read queries now means that change touches one file, not every page.
 */

import { prisma } from "../db.js";

const ACTIVE_VARIANT_WITH_STOCK = {
  where: { active: true },
  orderBy: { position: "asc" as const },
  include: { inventory: true },
};

export async function listFeaturedProducts(take = 4) {
  return prisma.product.findMany({
    where: { status: "ACTIVE", featured: true },
    orderBy: { createdAt: "desc" },
    take,
    include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
  });
}

export async function listCollections() {
  return prisma.collection.findMany({ orderBy: { position: "asc" } });
}

export async function getCollectionWithProducts(slug: string) {
  return prisma.collection.findUnique({
    where: { slug },
    include: {
      products: {
        orderBy: { position: "asc" },
        include: {
          product: {
            include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
          },
        },
      },
    },
  });
}

export async function listAllProducts() {
  return prisma.product.findMany({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
  });
}

export async function getProductBySlug(slug: string) {
  return prisma.product.findFirst({
    where: { slug, status: "ACTIVE" },
    include: {
      variants: ACTIVE_VARIANT_WITH_STOCK,
      images: { orderBy: { position: "asc" } },
    },
  });
}

/** Lowest active-variant price, for the catalogue-grid "from ETB X" display. */
export function fromPriceSantim(variants: readonly { priceSantim: number }[]): number {
  return variants.reduce((min, v) => Math.min(min, v.priceSantim), Number.POSITIVE_INFINITY);
}

export function totalAvailable(inventory: { onHand: number; reserved: number } | null | undefined): number {
  if (!inventory) return 0;
  return Math.max(0, inventory.onHand - inventory.reserved);
}
