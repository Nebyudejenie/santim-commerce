/**
 * Write-side catalogue: seller-owned listing management. Deliberately
 * separate from catalogue-service.ts (see that file's own module comment,
 * which already anticipated this split) — read traffic is orders of
 * magnitude higher than listing edits, and every function here does real
 * ownership-checking work a read query never needs to.
 *
 * OWNERSHIP IS THE WHOLE POINT of every function below: a seller editing
 * or even just fetching a product they don't own must get exactly the
 * same result as the product not existing — never a distinguishable
 * "forbidden" vs. "not found", and never trust a client-supplied sellerId.
 * Same discipline as get-user-orders.ts's own comment on customer order
 * scoping.
 */

import { birr, MoneyError } from "@santim/santimpay";
import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";

export class ListingError extends Error {
  override name = "ListingError";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseImageUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8); // a runaway paste must not create hundreds of image rows
}

function parseBirr(raw: string, field: string): number {
  const value = Number(raw);
  try {
    return birr(value);
  } catch (error) {
    throw new ListingError(error instanceof MoneyError ? `${field}: ${error.message}` : `${field} is invalid.`);
  }
}

export interface CreateProductInput {
  readonly title: string;
  readonly subtitle?: string;
  readonly description: string;
  readonly brand?: string;
  readonly imageUrls?: string;
  readonly variantTitle: string;
  readonly sku: string;
  readonly priceBirr: string;
  readonly onHand: string;
}

/** Always DRAFT — a seller publishes separately via setProductStatus. */
export async function createProduct(sellerId: string, input: CreateProductInput) {
  const title = input.title.trim();
  if (title.length < 3) throw new ListingError("Title must be at least 3 characters.");

  const description = input.description.trim();
  if (description.length < 10) throw new ListingError("Description must be at least 10 characters.");

  const sku = input.sku.trim();
  if (!sku) throw new ListingError("SKU is required.");

  const priceSantim = parseBirr(input.priceBirr, "Price");
  const onHand = Number(input.onHand);
  if (!Number.isInteger(onHand) || onHand < 0) {
    throw new ListingError("Stock quantity must be a non-negative whole number.");
  }

  const images = parseImageUrls(input.imageUrls);
  const baseSlug = slugify(title) || "listing";

  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    try {
      const product = await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            sellerId,
            slug,
            title,
            subtitle: input.subtitle?.trim() || null,
            description,
            brand: input.brand?.trim() || null,
            status: "DRAFT",
            heroImage: images[0] ?? null,
            images: {
              create: images.map((url, i) => ({ url, alt: `${title} — view ${i + 1}`, position: i })),
            },
          },
        });

        const variant = await tx.variant.create({
          data: {
            productId: created.id,
            sku,
            title: input.variantTitle.trim() || "Default",
            priceSantim,
          },
        });

        await tx.inventory.create({ data: { variantId: variant.id, onHand, reserved: 0 } });

        return created;
      });

      logger.info("listing.created", { productId: product.id, sellerId });
      return product;
    } catch (error) {
      if (isUniqueViolation(error)) continue; // slug collision — try the next suffix
      throw error;
    }
  }
  throw new ListingError("Could not generate a unique URL for this listing. Try a different title.");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/** Throws (never returns a foreign product) — see module comment on ownership. */
async function requireOwnedProduct(sellerId: string, productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.sellerId !== sellerId) {
    throw new ListingError("Listing not found.");
  }
  return product;
}

export interface UpdateProductInput {
  readonly title?: string;
  readonly subtitle?: string;
  readonly description?: string;
  readonly brand?: string;
}

export async function updateProduct(sellerId: string, productId: string, input: UpdateProductInput) {
  await requireOwnedProduct(sellerId, productId);

  const data: Record<string, string | null> = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length < 3) throw new ListingError("Title must be at least 3 characters.");
    data.title = title;
  }
  if (input.subtitle !== undefined) data.subtitle = input.subtitle.trim() || null;
  if (input.description !== undefined) {
    const description = input.description.trim();
    if (description.length < 10) throw new ListingError("Description must be at least 10 characters.");
    data.description = description;
  }
  if (input.brand !== undefined) data.brand = input.brand.trim() || null;

  const updated = await prisma.product.update({ where: { id: productId }, data });
  logger.info("listing.updated", { productId, sellerId });
  return updated;
}

const PUBLISHABLE: Record<string, readonly string[]> = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["ARCHIVED", "DRAFT"],
  ARCHIVED: ["ACTIVE"],
};

export async function setProductStatus(sellerId: string, productId: string, status: "DRAFT" | "ACTIVE" | "ARCHIVED") {
  const product = await requireOwnedProduct(sellerId, productId);
  if (!PUBLISHABLE[product.status]?.includes(status)) {
    throw new ListingError(`Cannot move a listing from ${product.status} to ${status}.`);
  }

  if (status === "ACTIVE") {
    const variantCount = await prisma.variant.count({ where: { productId } });
    if (variantCount === 0) {
      throw new ListingError("Add at least one variant before publishing.");
    }
  }

  const updated = await prisma.product.update({ where: { id: productId }, data: { status } });
  logger.info("listing.status_changed", { productId, sellerId, from: product.status, to: status });
  return updated;
}

export interface AddVariantInput {
  readonly title: string;
  readonly sku: string;
  readonly priceBirr: string;
  readonly onHand: string;
}

export async function addVariant(sellerId: string, productId: string, input: AddVariantInput) {
  await requireOwnedProduct(sellerId, productId);

  const sku = input.sku.trim();
  if (!sku) throw new ListingError("SKU is required.");
  const priceSantim = parseBirr(input.priceBirr, "Price");
  const onHand = Number(input.onHand);
  if (!Number.isInteger(onHand) || onHand < 0) {
    throw new ListingError("Stock quantity must be a non-negative whole number.");
  }

  try {
    const variant = await prisma.variant.create({
      data: { productId, sku, title: input.title.trim() || "Default", priceSantim },
    });
    await prisma.inventory.create({ data: { variantId: variant.id, onHand, reserved: 0 } });
    logger.info("listing.variant_added", { productId, sellerId, variantId: variant.id });
    return variant;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ListingError(`SKU "${sku}" is already used on this listing.`);
    }
    throw error;
  }
}

export interface UpdateVariantInput {
  readonly priceBirr?: string;
  readonly onHand?: number;
  readonly active?: boolean;
}

/** Ownership is checked via the variant's OWN product, never trusted from the caller. */
export async function updateVariant(sellerId: string, variantId: string, input: UpdateVariantInput) {
  const variant = await prisma.variant.findUnique({ where: { id: variantId }, include: { product: true } });
  if (!variant || variant.product.sellerId !== sellerId) {
    throw new ListingError("Variant not found.");
  }

  const data: Record<string, number | boolean> = {};
  if (input.priceBirr !== undefined) data.priceSantim = parseBirr(input.priceBirr, "Price");
  if (input.active !== undefined) data.active = input.active;

  const updated = await prisma.variant.update({ where: { id: variantId }, data });

  if (input.onHand !== undefined) {
    if (!Number.isInteger(input.onHand) || input.onHand < 0) {
      throw new ListingError("Stock quantity must be a non-negative whole number.");
    }
    // Absolute set, not a delta — this is a seller correcting their own
    // stock count, not a reservation/sale event (those go through
    // reservation.ts's atomic UPDATE, never through this path).
    await prisma.inventory.update({ where: { variantId }, data: { onHand: input.onHand } });
  }

  logger.info("listing.variant_updated", { variantId, sellerId });
  return updated;
}

export async function listSellerProducts(sellerId: string) {
  return prisma.product.findMany({
    where: { sellerId },
    orderBy: { updatedAt: "desc" },
    include: { variants: { include: { inventory: true } } },
  });
}

/** Returns null (not a throw) for a product this seller doesn't own — see
 * this file's own "never distinguishable" ownership comment; the caller
 * decides how to present "not found" to the seller. */
export async function getSellerProduct(sellerId: string, productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { include: { inventory: true } }, images: { orderBy: { position: "asc" } } },
  });
  if (!product || product.sellerId !== sellerId) return null;
  return product;
}

/**
 * Admin-only editorial curation — deliberately NOT something a seller can
 * set on their own listing (see `updateProduct` above, which has no
 * `featured` field at all): letting sellers self-promote onto the
 * homepage would turn "featured" into a race, not a real editorial
 * decision. `Product.featured` has existed in the schema and been read by
 * `listFeaturedProducts` since an earlier phase, but nothing anywhere
 * could ever set it to true outside seed data until this function.
 */
export async function setProductFeaturedAsAdmin(productId: string, featured: boolean): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { featured } });
  logger.info("listing.featured_changed", { productId, featured });
}
