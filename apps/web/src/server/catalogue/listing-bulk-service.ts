/**
 * Bulk CSV import/export for a seller's own catalogue — real spreadsheet
 * tooling for a seller onboarding (or auditing) a large number of
 * listings at once, not a one-by-one form.
 *
 * Import deliberately only CREATES new listings, reusing `createProduct`
 * itself (see listing-service.ts) — one call per valid row, so a CSV row
 * is validated by exactly the same rules a manual form submission is,
 * never a parallel, drift-prone copy of that logic. Updating an EXISTING
 * listing by SKU via CSV is real, meaningfully bigger functionality
 * (matching rows to existing variants, deciding what "update" even means
 * for a field a row leaves blank) — deliberately not built here; a seller
 * who wants to bulk-create is what this covers.
 *
 * A malformed or invalid row must never abort the whole batch — see
 * `importProductsFromCsv`'s per-row try/catch. A seller pasting 200 rows
 * with one typo should get 199 real listings and one clear error, not
 * zero listings and a stack trace.
 */

import { parseCsvWithHeader, writeCsv } from "./csv.js";
import { createProduct, listSellerProducts, ListingError } from "./listing-service.js";

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
