/**
 * Seed data for local development and demos.
 *
 * Deliberately idempotent (`upsert` throughout): running this twice must not
 * duplicate the catalogue or wipe live inventory numbers a developer has been
 * poking at. A seed script that can only run once against an empty database
 * is a seed script nobody trusts enough to actually run.
 *
 * Brand: "LUMEN" — a minimal, premium apparel/footwear line invented for this
 * project. Prices are realistic ETB retail figures; images are placeholder
 * URLs (picsum.photos) standing in for a real DAM/CDN.
 */

import { PrismaClient } from "@prisma/client";
import { birr } from "@santim/santimpay";

const prisma = new PrismaClient();

function img(seed: string, w = 1200, h = 1500): string {
  return `https://picsum.photos/seed/${seed}/${w}/${h}`;
}

interface VariantSeed {
  sku: string;
  title: string;
  options: Record<string, string>;
  priceSantim: number;
  compareAtSantim?: number;
  onHand: number;
}

interface ProductSeed {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  brand: string;
  featured?: boolean;
  collections: string[];
  variants: VariantSeed[];
}

const COLLECTIONS = [
  { slug: "new-arrivals", title: "New Arrivals", description: "The latest from LUMEN, fresh in." },
  { slug: "best-sellers", title: "Best Sellers", description: "What everyone keeps coming back for." },
  { slug: "outerwear", title: "Outerwear", description: "Built for Addis mornings and rainy season." },
  { slug: "footwear", title: "Footwear", description: "Minimal silhouettes, maximum comfort." },
] as const;

const SIZES = ["S", "M", "L", "XL"] as const;
const SHOE_SIZES = ["40", "41", "42", "43", "44"] as const;

function apparelVariants(skuBase: string, priceBirr: number, stock: number[]): VariantSeed[] {
  return SIZES.map((size, i) => ({
    sku: `${skuBase}-${size}`,
    title: size,
    options: { Size: size },
    priceSantim: birr(priceBirr),
    onHand: stock[i] ?? 10,
  }));
}

function shoeVariants(skuBase: string, priceBirr: number, stock: number[]): VariantSeed[] {
  return SHOE_SIZES.map((size, i) => ({
    sku: `${skuBase}-${size}`,
    title: `EU ${size}`,
    options: { Size: size },
    priceSantim: birr(priceBirr),
    onHand: stock[i] ?? 10,
  }));
}

/// Which seed seller owns each product, by slug. Real multi-vendor data,
/// not one store with everything under it — this is the thing the whole
/// marketplace pivot needs seed data to actually exercise: seller-scoped
/// queries, seller dashboards, and storefront pages with more than one
/// seller in them.
const PRODUCT_SELLER_SLUG: Record<string, string> = {
  "aria-overshirt": "lumen",
  "meridian-parka": "lumen",
  "essential-tee": "lumen",
  "field-trouser": "lumen",
  "harbor-knit": "lumen",
  "canvas-tote": "lumen",
  "runner-low": "harbor-footwear",
  "desert-chukka": "harbor-footwear",
};

const SELLERS = [
  {
    slug: "lumen",
    storeName: "LUMEN",
    ownerEmail: "seller-lumen@example.et",
    description: "Minimal, premium apparel and outerwear — cut to last, not to trend.",
  },
  {
    slug: "harbor-footwear",
    storeName: "Harbor Footwear Co.",
    ownerEmail: "seller-harbor@example.et",
    description: "Small-batch footwear, built on the same lasts for a decade running.",
  },
];

const PRODUCTS: ProductSeed[] = [
  {
    slug: "aria-overshirt",
    title: "Aria Overshirt",
    subtitle: "Brushed cotton, unlined",
    description:
      "A structured overshirt in brushed cotton twill, cut for a relaxed drape. Corozo buttons, " +
      "single chest pocket, garment-dyed for a lived-in finish that only gets better with wear.",
    brand: "LUMEN",
    featured: true,
    collections: ["new-arrivals", "outerwear"],
    variants: apparelVariants("ARIA-OVR", 3450, [6, 12, 12, 4]),
  },
  {
    slug: "meridian-parka",
    title: "Meridian Parka",
    subtitle: "Water-resistant, packable",
    description:
      "A three-layer shell built for Addis's short, sharp rains. Packs into its own chest pocket, " +
      "taped seams throughout, adjustable storm hood with a wired brim.",
    brand: "LUMEN",
    featured: true,
    collections: ["new-arrivals", "outerwear", "best-sellers"],
    variants: apparelVariants("MER-PRK", 6900, [3, 8, 6, 2]),
  },
  {
    slug: "essential-tee",
    title: "Essential Tee",
    subtitle: "220gsm combed cotton",
    description:
      "The tee everything else is designed around. Heavyweight combed cotton, a collar that holds " +
      "its shape after fifty washes, cut with just enough room to layer.",
    brand: "LUMEN",
    collections: ["best-sellers"],
    variants: apparelVariants("ESS-TEE", 950, [20, 30, 30, 15]),
  },
  {
    slug: "field-trouser",
    title: "Field Trouser",
    subtitle: "Cotton ripstop, tapered",
    description:
      "A tapered trouser in cotton ripstop with a gusseted crotch for actual movement. Two rear " +
      "welt pockets, a hidden internal phone pocket, finished with a clean bar-tack at every stress point.",
    brand: "LUMEN",
    collections: ["best-sellers"],
    variants: apparelVariants("FLD-TRS", 2650, [8, 14, 14, 6]),
  },
  {
    slug: "runner-low",
    title: "Runner Low",
    subtitle: "Knit upper, EVA sole",
    description:
      "A low-profile trainer in a seamless knit upper with a full-length EVA midsole. Reflective " +
      "heel tab, recycled laces, built to disappear on your foot within a day.",
    brand: "Harbor Footwear Co.",
    featured: true,
    collections: ["footwear", "new-arrivals"],
    variants: shoeVariants("RUN-LOW", 4200, [5, 9, 12, 8, 3]),
  },
  {
    slug: "desert-chukka",
    title: "Desert Chukka",
    subtitle: "Suede, crepe sole",
    description:
      "A two-eyelet chukka in oiled suede on a natural crepe sole. Unlined for a broken-in feel from " +
      "the first wear, finished with waxed cotton laces.",
    brand: "Harbor Footwear Co.",
    collections: ["footwear"],
    variants: shoeVariants("DST-CHK", 5100, [2, 4, 5, 3, 1]),
  },
  {
    slug: "harbor-knit",
    title: "Harbor Knit",
    subtitle: "Merino blend crewneck",
    description:
      "A fine-gauge merino blend crewneck, cut close without clinging. Ribbed collar, cuff, and hem " +
      "hold their shape through a full season of wear.",
    brand: "LUMEN",
    collections: ["new-arrivals"],
    variants: apparelVariants("HBR-KNT", 3100, [7, 10, 9, 4]),
  },
  {
    slug: "canvas-tote",
    title: "Canvas Tote",
    subtitle: "18oz canvas, leather straps",
    description:
      "A heavyweight canvas tote with full-grain leather straps riveted at every stress point. One " +
      "size, one job: carrying everything else on this list home.",
    brand: "LUMEN",
    collections: ["best-sellers"],
    variants: [
      { sku: "CNV-TOTE-OS", title: "One Size", options: { Size: "OS" }, priceSantim: birr(1450), onHand: 25 },
    ],
  },
];

async function main() {
  console.log("Seeding LUMEN catalogue…");

  const sellerIds = new Map<string, string>();
  for (const s of SELLERS) {
    const owner = await prisma.user.upsert({
      where: { email: s.ownerEmail },
      create: { email: s.ownerEmail, role: "CUSTOMER" },
      update: {},
    });
    const seller = await prisma.seller.upsert({
      where: { ownerId: owner.id },
      create: {
        ownerId: owner.id,
        storeName: s.storeName,
        slug: s.slug,
        description: s.description,
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedBy: "seed-script",
      },
      update: { storeName: s.storeName, description: s.description },
    });
    sellerIds.set(s.slug, seller.id);
    console.log(`  ✓ seller: ${s.storeName}`);
  }

  const collectionIds = new Map<string, string>();
  for (const [i, c] of COLLECTIONS.entries()) {
    const row = await prisma.collection.upsert({
      where: { slug: c.slug },
      create: { ...c, position: i, heroImage: img(`collection-${c.slug}`, 1600, 900) },
      update: { title: c.title, description: c.description },
    });
    collectionIds.set(c.slug, row.id);
  }

  for (const p of PRODUCTS) {
    const sellerSlug = PRODUCT_SELLER_SLUG[p.slug];
    const sellerId = sellerSlug ? sellerIds.get(sellerSlug) : undefined;
    if (!sellerId) throw new Error(`No seller mapped for product "${p.slug}" — add it to PRODUCT_SELLER_SLUG.`);

    const product = await prisma.product.upsert({
      where: { slug: p.slug },
      create: {
        sellerId,
        slug: p.slug,
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        brand: p.brand,
        status: "ACTIVE",
        featured: p.featured ?? false,
        heroImage: img(p.slug),
        metaTitle: `${p.title} — ${p.brand}`,
        metaDescription: p.subtitle,
      },
      update: {
        // Re-running the seed against a database migrated from before this
        // seller domain existed (every pre-existing product was backfilled
        // onto a placeholder "Legacy Catalogue" seller — see the migration's
        // own comment) must actually move products onto their real sellers,
        // not just leave them there forever.
        sellerId,
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        brand: p.brand,
        featured: p.featured ?? false,
      },
    });

    // Two images per product: hero + one detail shot. A stable synthetic id
    // (rather than the auto-generated cuid) is what makes this idempotent —
    // upsert-by-id creates the row on the first run and just updates the url
    // on every run after, with no special-casing needed either way.
    for (let i = 0; i < 2; i++) {
      const url = img(`${p.slug}-${i}`);
      await prisma.productImage.upsert({
        where: { id: `${product.id}-img-${i}` },
        create: {
          id: `${product.id}-img-${i}`,
          productId: product.id,
          url,
          alt: `${p.title} — view ${i + 1}`,
          position: i,
          width: 1200,
          height: 1500,
        },
        update: { url },
      });
    }

    for (const [collectionSlug, position] of p.collections.map((s, i) => [s, i] as const)) {
      const collectionId = collectionIds.get(collectionSlug);
      if (!collectionId) continue;
      await prisma.collectionProduct.upsert({
        where: { collectionId_productId: { collectionId, productId: product.id } },
        create: { collectionId, productId: product.id, position },
        update: {},
      });
    }

    for (const [vIndex, v] of p.variants.entries()) {
      const variant = await prisma.variant.upsert({
        where: { productId_sku: { productId: product.id, sku: v.sku } },
        create: {
          productId: product.id,
          sku: v.sku,
          title: v.title,
          options: v.options,
          priceSantim: v.priceSantim,
          compareAtSantim: v.compareAtSantim ?? null,
          position: vIndex,
        },
        update: { priceSantim: v.priceSantim },
      });

      await prisma.inventory.upsert({
        where: { variantId: variant.id },
        // Only set stock on FIRST creation — re-running the seed must not
        // stomp on inventory numbers a developer has been testing against.
        create: { variantId: variant.id, onHand: v.onHand, reserved: 0, lowStockThreshold: 5 },
        update: {},
      });
    }

    console.log(`  ✓ ${p.title} (${p.variants.length} variant${p.variants.length === 1 ? "" : "s"})`);
  }

  console.log(`Done: ${COLLECTIONS.length} collections, ${PRODUCTS.length} products.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
