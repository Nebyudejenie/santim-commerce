/**
 * Read-side catalogue queries.
 *
 * Kept separate from any future write/admin path: browsing traffic is
 * orders-of-magnitude higher than catalogue edits, and this is where a
 * caching layer (Phase 11 in the curriculum) gets added first. Isolating the
 * read queries now means that change touches one file, not every page.
 */

import { prisma } from "../db.js";

export const ACTIVE_VARIANT_WITH_STOCK = {
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
export const VISIBLE_PRODUCT_WHERE = {
  status: "ACTIVE" as const,
  seller: { status: "APPROVED" as const, vacationAt: null },
};

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
 * Cross-sell for the product page — confirmed absent (no "related" /
 * "similar" / "also bought" anywhere in this codebase). Deliberately the
 * simplest correct definition, not a recommendation engine: other
 * currently-visible products from the SAME seller, matching how
 * comparable marketplaces (Etsy, eBay) frame this as "more from this
 * shop" rather than pretending to a collaborative-filtering signal this
 * app has no data to back. `excludeProductId` keeps a product from
 * recommending itself.
 */
export async function listRelatedProducts(sellerId: string, excludeProductId: string, take = 4) {
  return prisma.product.findMany({
    where: { ...VISIBLE_PRODUCT_WHERE, sellerId, id: { not: excludeProductId } },
    orderBy: { createdAt: "desc" },
    take,
    include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
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
    select: { id: true, storeName: true, slug: true, description: true, logoUrl: true, createdAt: true, vacationAt: true },
  });
  if (!seller) return null;

  // Deliberately NOT reusing VISIBLE_PRODUCT_WHERE here — that predicate
  // filters by seller.status, but this function already established
  // seller.status === APPROVED via the query above. Checking vacationAt
  // explicitly (rather than skipping the products query when on
  // vacation) keeps the shape consistent either way — an empty array,
  // not an undefined field.
  const products = seller.vacationAt
    ? []
    : await prisma.product.findMany({
        where: { sellerId: seller.id, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        include: { variants: ACTIVE_VARIANT_WITH_STOCK, images: { orderBy: { position: "asc" } } },
      });

  return { seller, products };
}

const SITEMAP_MAX_ENTRIES = 5_000;

/** Slug + freshness only — sitemap.ts has no use for full variant/image
 * payloads, so this deliberately avoids listAllProducts()'s eager includes. */
export async function listProductSlugsForSitemap() {
  return prisma.product.findMany({
    where: VISIBLE_PRODUCT_WHERE,
    select: { slug: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: SITEMAP_MAX_ENTRIES,
  });
}

export async function listSellerSlugsForSitemap() {
  return prisma.seller.findMany({
    where: { status: "APPROVED" },
    select: { slug: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: SITEMAP_MAX_ENTRIES,
  });
}

/** Lowest active-variant price, for the catalogue-grid "from ETB X" display. */
export function fromPriceSantim(variants: readonly { priceSantim: number }[]): number {
  return variants.reduce((min, v) => Math.min(min, v.priceSantim), Number.POSITIVE_INFINITY);
}

/**
 * `allowBackorder` (reservation.ts's own atomic, already-correct
 * oversell gate) was confirmed to have zero storefront read path before
 * this: every caller here floored at 0 regardless, so a merchant could
 * never actually make backorder-enabled stock buyable — the "Add to
 * bag" button stayed disabled and the swatch stayed unclickable the
 * moment real stock hit zero, no matter what the flag said. Once REAL
 * stock is exhausted, a backorder-enabled variant returns
 * `Infinity` — never displayed as a number anywhere (every caller only
 * ever compares it to 0 or a threshold), so this is a safe sentinel for
 * "always purchasable," not a real inventory count. While real stock is
 * still positive, the actual number is returned unchanged — backorder
 * only changes what happens once it's genuinely gone.
 */
export function totalAvailable(
  inventory: { onHand: number; reserved: number; allowBackorder?: boolean } | null | undefined,
): number {
  if (!inventory) return 0;
  const real = inventory.onHand - inventory.reserved;
  if (inventory.allowBackorder && real <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, real);
}
