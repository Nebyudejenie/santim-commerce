"use server";

/**
 * Seller listing mutations. Every action calls `requireApprovedSeller`
 * itself — same discipline as admin-actions.ts/seller-actions.ts's own
 * module comments: a Server Action must check its own authorization, never
 * rely on the page that renders its trigger form. `requireApprovedSeller`
 * additionally rejects PENDING/SUSPENDED/REJECTED sellers, not just
 * unauthenticated ones — a seller whose application hasn't been reviewed
 * yet must not be able to create listings by discovering the action.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "../auth/guard.js";
import { requireApprovedSeller, SellerError } from "../sellers/seller-service.js";
import {
  addVariant,
  createProduct,
  ListingError,
  setProductStatus,
  updateProduct,
  updateVariant,
} from "../catalogue/listing-service.js";
import {
  importProductsFromCsv,
  updateProductsFromCsv,
  type ImportSummary,
  type UpdateSummary,
} from "../catalogue/listing-bulk-service.js";
import { logger } from "../observability/logger.js";

export interface ListingActionState {
  readonly ok: boolean;
  readonly message?: string;
}

async function sellerIdOrState(): Promise<string | ListingActionState> {
  const user = await requireUser();
  try {
    const seller = await requireApprovedSeller(user.id);
    return seller.id;
  } catch (error) {
    return { ok: false, message: error instanceof SellerError ? error.message : "Not authorized." };
  }
}

export async function createProductAction(
  _prev: ListingActionState,
  formData: FormData,
): Promise<ListingActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  let productId: string;
  try {
    const product = await createProduct(sellerId, {
      title: String(formData.get("title") ?? ""),
      subtitle: String(formData.get("subtitle") ?? ""),
      description: String(formData.get("description") ?? ""),
      brand: String(formData.get("brand") ?? ""),
      imageUrls: String(formData.get("imageUrls") ?? ""),
      variantTitle: String(formData.get("variantTitle") ?? ""),
      sku: String(formData.get("sku") ?? ""),
      priceBirr: String(formData.get("priceBirr") ?? ""),
      onHand: String(formData.get("onHand") ?? ""),
    });
    productId = product.id;
  } catch (error) {
    if (error instanceof ListingError) return { ok: false, message: error.message };
    logger.error("listing.create_action_failed", { error: (error as Error).message });
    return { ok: false, message: "Something went wrong creating your listing. Please try again." };
  }

  revalidatePath("/sell/products");
  redirect(`/sell/products/${productId}`);
}

export async function updateProductAction(
  _prev: ListingActionState,
  formData: FormData,
): Promise<ListingActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const productId = String(formData.get("productId") ?? "");
  try {
    await updateProduct(sellerId, productId, {
      title: String(formData.get("title") ?? ""),
      subtitle: String(formData.get("subtitle") ?? ""),
      description: String(formData.get("description") ?? ""),
      brand: String(formData.get("brand") ?? ""),
      metaTitle: String(formData.get("metaTitle") ?? ""),
      metaDescription: String(formData.get("metaDescription") ?? ""),
    });
  } catch (error) {
    if (error instanceof ListingError) return { ok: false, message: error.message };
    logger.error("listing.update_action_failed", { productId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/sell/products/${productId}`);
  return { ok: true, message: "Saved." };
}

export async function setProductStatusAction(
  _prev: ListingActionState,
  formData: FormData,
): Promise<ListingActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const productId = String(formData.get("productId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "DRAFT" && status !== "ACTIVE" && status !== "ARCHIVED") {
    return { ok: false, message: "Invalid status." };
  }

  try {
    await setProductStatus(sellerId, productId, status);
  } catch (error) {
    if (error instanceof ListingError) return { ok: false, message: error.message };
    logger.error("listing.status_action_failed", { productId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/sell/products/${productId}`);
  revalidatePath("/sell/products");
  return { ok: true, message: `Listing is now ${status}.` };
}

export async function addVariantAction(
  _prev: ListingActionState,
  formData: FormData,
): Promise<ListingActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const productId = String(formData.get("productId") ?? "");
  try {
    await addVariant(sellerId, productId, {
      title: String(formData.get("title") ?? ""),
      sku: String(formData.get("sku") ?? ""),
      priceBirr: String(formData.get("priceBirr") ?? ""),
      onHand: String(formData.get("onHand") ?? ""),
      compareAtBirr: String(formData.get("compareAtBirr") ?? ""),
    });
  } catch (error) {
    if (error instanceof ListingError) return { ok: false, message: error.message };
    logger.error("listing.add_variant_action_failed", { productId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/sell/products/${productId}`);
  return { ok: true, message: "Variant added." };
}

export async function updateVariantAction(
  _prev: ListingActionState,
  formData: FormData,
): Promise<ListingActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const variantId = String(formData.get("variantId") ?? "");
  const productId = String(formData.get("productId") ?? "");
  const activeRaw = formData.get("active");

  try {
    await updateVariant(sellerId, variantId, {
      priceBirr: String(formData.get("priceBirr") ?? ""),
      onHand: Number(formData.get("onHand") ?? ""),
      active: activeRaw === null ? undefined : activeRaw === "on",
      lowStockThreshold: Number(formData.get("lowStockThreshold") ?? ""),
      compareAtBirr: String(formData.get("compareAtBirr") ?? ""),
    });
  } catch (error) {
    if (error instanceof ListingError) return { ok: false, message: error.message };
    logger.error("listing.update_variant_action_failed", { variantId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/sell/products/${productId}`);
  return { ok: true, message: "Variant updated." };
}

export interface ImportCsvActionState {
  readonly ok: boolean;
  readonly message?: string;
  readonly summary?: ImportSummary;
}

export async function importProductsCsvAction(
  _prev: ImportCsvActionState,
  formData: FormData,
): Promise<ImportCsvActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const file = formData.get("csvFile");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a CSV file to upload." };
  }
  // A runaway upload must never tie up a request indefinitely — 2MB is
  // generous for a real product-catalogue CSV (thousands of rows).
  if (file.size > 2 * 1024 * 1024) {
    return { ok: false, message: "That file is too large (max 2MB)." };
  }

  const csvText = await file.text();

  try {
    const summary = await importProductsFromCsv(sellerId, csvText);
    revalidatePath("/sell/products");
    return {
      ok: true,
      message: `${summary.createdCount} listing${summary.createdCount === 1 ? "" : "s"} created${summary.failedCount > 0 ? `, ${summary.failedCount} row${summary.failedCount === 1 ? "" : "s"} failed` : ""}.`,
      summary,
    };
  } catch (error) {
    if (error instanceof ListingError) return { ok: false, message: error.message };
    logger.error("listing.import_csv_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong reading that file. Please try again." };
  }
}

export interface UpdateCsvActionState {
  readonly ok: boolean;
  readonly message?: string;
  readonly summary?: UpdateSummary;
}

export async function updateProductsCsvAction(
  _prev: UpdateCsvActionState,
  formData: FormData,
): Promise<UpdateCsvActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const file = formData.get("csvFile");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a CSV file to upload." };
  }
  if (file.size > 2 * 1024 * 1024) {
    return { ok: false, message: "That file is too large (max 2MB)." };
  }

  const csvText = await file.text();

  try {
    const summary = await updateProductsFromCsv(sellerId, csvText);
    revalidatePath("/sell/products");
    return {
      ok: true,
      message: `${summary.updatedCount} listing${summary.updatedCount === 1 ? "" : "s"} updated${summary.failedCount > 0 ? `, ${summary.failedCount} row${summary.failedCount === 1 ? "" : "s"} failed` : ""}.`,
      summary,
    };
  } catch (error) {
    if (error instanceof ListingError) return { ok: false, message: error.message };
    logger.error("listing.update_csv_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong reading that file. Please try again." };
  }
}
