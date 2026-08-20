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

/**
 * A product is genuinely visible to a buyer only while BOTH the product
 * itself is ACTIVE and its seller is currently APPROVED — a suspended
 * seller's listings must disappear from browsing/search immediately, not
 * just stop accepting new orders (the master mandate's "seller suspension"
 * edge case). cart-service.ts's addLine and checkout-service.ts's
 * placeOrder re-check the identical condition at add-to-cart and checkout
 * time respectively, for the window between "seen while browsing" and
 * "acted on".
 */
const VISIBLE_PRODUCT_WHERE = { status: "ACTIVE" as const, seller: { status: "APPROVED" as const } };

export async function listFeaturedProducts(take = 4) {
  return prisma.product.findMany({
    where: { ...VISIBLE_PRODUCT_WHERE, featured: true },
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
        where: { product: VISIBLE_PRODUCT_WHERE },
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
    where: VISIBLE_PRODUCT_WHERE,
    orderBy: { createdAt: "desc" },
    include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
  });
}

export async function getProductBySlug(slug: string) {
  return prisma.product.findFirst({
    where: { slug, ...VISIBLE_PRODUCT_WHERE },
    include: {
      variants: ACTIVE_VARIANT_WITH_STOCK,
      images: { orderBy: { position: "asc" } },
      seller: { select: { storeName: true, slug: true } },
    },
  });
}

/**
 * The public storefront view of a seller — only ever returns an APPROVED
 * seller (a suspended/pending/rejected one is not a real store to browse,
 * same visibility rule as VISIBLE_PRODUCT_WHERE above) and only their
 * currently-visible products.
 */
export async function getSellerStorefront(slug: string) {
  const seller = await prisma.seller.findFirst({
    where: { slug, status: "APPROVED" },
    select: { id: true, storeName: true, slug: true, description: true, logoUrl: true, createdAt: true },
  });
  if (!seller) return null;

  const products = await prisma.product.findMany({
    where: { sellerId: seller.id, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
  });

  return { seller, products };
}

/** Lowest active-variant price, for the catalogue-grid "from ETB X" display. */
export function fromPriceSantim(variants: readonly { priceSantim: number }[]): number {
  return variants.reduce((min, v) => Math.min(min, v.priceSantim), Number.POSITIVE_INFINITY);
}

export function totalAvailable(inventory: { onHand: number; reserved: number } | null | undefined): number {
  if (!inventory) return 0;
  return Math.max(0, inventory.onHand - inventory.reserved);
}
