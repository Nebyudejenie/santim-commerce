/**
 * Bulk CSV import/export for a seller's own catalogue — real spreadsheet
 * tooling for a seller onboarding (or auditing) a large number of
 * listings at once, not a one-by-one form.
 *
 * Import (create) reuses `createProduct` itself (see listing-service.ts)
 * — one call per valid row, so a CSV row is validated by exactly the
 * same rules a manual form submission is, never a parallel, drift-prone
 * copy of that logic. Update-by-SKU (`updateProductsFromCsv`, below)
 * reuses `updateVariant`/`updateProduct`/`setProductStatus` the exact
 * same way — a blank cell means "leave this field unchanged" (only a
 * non-empty cell is passed through), the same optional-field semantics
 * `UpdateVariantInput`/`UpdateProductInput` already use for a manual
 * edit, not a new, parallel notion of "what does blank mean" invented
 * here. This was previously deferred as a separate, bigger feature —
 * built now that reusing the existing update functions removed the hard
 * part the original deferral was actually about.
 *
 * A malformed or invalid row must never abort the whole batch — see
 * `importProductsFromCsv`'s per-row try/catch. A seller pasting 200 rows
 * with one typo should get 199 real listings and one clear error, not
 * zero listings and a stack trace. `updateProductsFromCsv` follows the
 * identical per-row discipline.
 */

import { prisma } from "../db.js";
import { parseCsvWithHeader, writeCsv } from "./csv.js";
import {
  createProduct,
  listSellerProducts,
  ListingError,
  setProductStatus,
  updateProduct,
  updateVariant,
  type UpdateProductInput,
  type UpdateVariantInput,
} from "./listing-service.js";

const EXPORT_HEADER = ["title", "subtitle", "description", "brand", "sku", "priceBirr", "onHand", "status"] as const;

export async function exportSellerProductsCsv(sellerId: string): Promise<string> {
  const products = await listSellerProducts(sellerId);

  const rows = products.flatMap((product) =>
    product.variants.map((variant) => [
      product.title,
      product.subtitle ?? "",
      product.description,
      product.brand ?? "",
      variant.sku,
      (variant.priceSantim / 100).toFixed(2),
      String(variant.inventory?.onHand ?? 0),
      product.status,
    ]),
  );

  return writeCsv(EXPORT_HEADER, rows);
}

export interface ImportRowResult {
  readonly row: number; // 1-indexed against the data rows, header excluded — what a seller sees when they open the file
  readonly ok: boolean;
  readonly title?: string;
  readonly message?: string;
}

export interface ImportSummary {
  readonly createdCount: number;
  readonly failedCount: number;
  readonly results: readonly ImportRowResult[];
}

const REQUIRED_COLUMNS = ["title", "description", "sku", "priceBirr", "onHand"] as const;

export async function importProductsFromCsv(sellerId: string, csvText: string): Promise<ImportSummary> {
  const records = parseCsvWithHeader(csvText);

  if (records.length === 0) {
    return { createdCount: 0, failedCount: 0, results: [] };
  }

  const missingColumns = REQUIRED_COLUMNS.filter((col) => !(col in records[0]!));
  if (missingColumns.length > 0) {
    throw new ListingError(`Missing required column(s): ${missingColumns.join(", ")}.`);
  }

  const results: ImportRowResult[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    try {
      const product = await createProduct(sellerId, {
        title: record.title ?? "",
        subtitle: record.subtitle,
        description: record.description ?? "",
        brand: record.brand,
        imageUrls: record.imageUrls,
        variantTitle: "Default",
        sku: record.sku ?? "",
        priceBirr: record.priceBirr ?? "",
        onHand: record.onHand ?? "",
      });
      results.push({ row: i + 1, ok: true, title: product.title });
    } catch (error) {
      results.push({
        row: i + 1,
        ok: false,
        message: error instanceof ListingError ? error.message : "Something went wrong creating this row.",
      });
    }
  }

  const createdCount = results.filter((r) => r.ok).length;
  return { createdCount, failedCount: results.length - createdCount, results };
}

export interface UpdateRowResult {
  readonly row: number; // 1-indexed against the data rows, header excluded
  readonly ok: boolean;
  readonly sku?: string;
  readonly message?: string;
}

export interface UpdateSummary {
  readonly updatedCount: number;
  readonly failedCount: number;
  readonly results: readonly UpdateRowResult[];
}

const VALID_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;

/**
 * Update-by-SKU: `sku` is the only required column, matched against this
 * seller's OWN catalogue only — a SKU that belongs to another seller (or
 * doesn't exist at all) simply matches zero rows and fails that row with
 * "No listing found", the same ownership-via-WHERE discipline as every
 * other seller-scoped query in this codebase, never a distinguishable
 * "yes that SKU exists, but it's not yours".
 *
 * Every other column is optional per-row: a blank cell changes nothing
 * for that field. Reuses `updateVariant`/`updateProduct`/
 * `setProductStatus` directly — a CSV row is validated (price format,
 * description length, legal status transitions, the works) by exactly
 * the same rules a manual edit is, never a parallel copy of that logic.
 */
export async function updateProductsFromCsv(sellerId: string, csvText: string): Promise<UpdateSummary> {
  const records = parseCsvWithHeader(csvText);
  if (records.length === 0) {
    return { updatedCount: 0, failedCount: 0, results: [] };
  }

  if (!("sku" in records[0]!)) {
    throw new ListingError("Missing required column: sku.");
  }

  const results: UpdateRowResult[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const sku = record.sku?.trim();
    try {
      if (!sku) throw new ListingError("Missing sku.");

      const variant = await prisma.variant.findFirst({
        where: { sku, product: { sellerId } },
        select: { id: true, productId: true },
      });
      if (!variant) throw new ListingError(`No listing found with SKU "${sku}".`);

      let onHand: number | undefined;
      if (record.onHand?.trim()) {
        onHand = Number(record.onHand.trim());
        if (!Number.isInteger(onHand) || onHand < 0) {
          throw new ListingError(`Invalid onHand "${record.onHand}" — must be a non-negative whole number.`);
        }
      }
      const variantInput: UpdateVariantInput = {
        ...(record.priceBirr?.trim() ? { priceBirr: record.priceBirr.trim() } : {}),
        ...(onHand !== undefined ? { onHand } : {}),
      };
      if (Object.keys(variantInput).length > 0) {
        await updateVariant(sellerId, variant.id, variantInput);
      }

      const productInput: UpdateProductInput = {
        ...(record.title?.trim() ? { title: record.title.trim() } : {}),
        ...(record.subtitle?.trim() ? { subtitle: record.subtitle.trim() } : {}),
        ...(record.description?.trim() ? { description: record.description.trim() } : {}),
        ...(record.brand?.trim() ? { brand: record.brand.trim() } : {}),
      };
      if (Object.keys(productInput).length > 0) {
        await updateProduct(sellerId, variant.productId, productInput);
      }

      if (record.status?.trim()) {
        const status = record.status.trim().toUpperCase();
        if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
          throw new ListingError(`Invalid status "${record.status}" — must be DRAFT, ACTIVE, or ARCHIVED.`);
        }
        await setProductStatus(sellerId, variant.productId, status as (typeof VALID_STATUSES)[number]);
      }

      results.push({ row: i + 1, ok: true, sku });
    } catch (error) {
      results.push({
        row: i + 1,
        ok: false,
        sku,
        message: error instanceof ListingError ? error.message : "Something went wrong updating this row.",
      });
    }
  }

  const updatedCount = results.filter((r) => r.ok).length;
  return { updatedCount, failedCount: results.length - updatedCount, results };
}
