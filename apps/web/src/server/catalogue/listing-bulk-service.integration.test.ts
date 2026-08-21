/**
 * Integration test — requires a real Postgres. The property that matters
 * most for import: a bad row must never abort the whole batch — a seller
 * pasting many real rows with one typo should get all the good rows
 * created and one clear per-row error, not zero listings. For export:
 * round-trips through the real csv.ts writer/parser and reflects real,
 * current inventory — not a stale or fabricated snapshot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { exportSellerProductsCsv, importProductsFromCsv, updateProductsFromCsv } from "./listing-bulk-service.ts";
import { parseCsvWithHeader } from "./csv.ts";
import { ListingError } from "./listing-service.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `bulk-test-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Bulk Test Seller ${suffix}`, slug: `bulk-test-seller-${suffix}`, status: "APPROVED" },
  });
  return seller.id;
}

test("importProductsFromCsv creates a real DRAFT listing per valid row", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  const csv = [
    "title,description,sku,priceBirr,onHand",
    `Bulk Test Tee ${suffix},A real description long enough to pass validation.,BULK-${suffix}-1,199.99,25`,
  ].join("\n");

  const summary = await importProductsFromCsv(sellerId, csv);
  assert.equal(summary.createdCount, 1);
  assert.equal(summary.failedCount, 0);

  const product = await prisma.product.findFirstOrThrow({ where: { sellerId, title: `Bulk Test Tee ${suffix}` }, include: { variants: { include: { inventory: true } } } });
  assert.equal(product.status, "DRAFT", "an imported listing must still require an explicit publish, same as one-by-one creation");
  assert.equal(product.variants[0]!.sku, `BULK-${suffix}-1`);
  assert.equal(product.variants[0]!.priceSantim, 19_999);
  assert.equal(product.variants[0]!.inventory!.onHand, 25);
});

test("a bad row does not abort the whole batch — real rows still get created, the bad one reports a real per-row error", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  const csv = [
    "title,description,sku,priceBirr,onHand",
    `Good Item A ${suffix},A real description long enough to pass validation.,BULK-${suffix}-A,50.00,10`,
    `x,too short,BULK-${suffix}-B,50.00,10`, // title too short — must fail validation
    `Good Item C ${suffix},A real description long enough to pass validation.,BULK-${suffix}-C,50.00,10`,
  ].join("\n");

  const summary = await importProductsFromCsv(sellerId, csv);
  assert.equal(summary.createdCount, 2, "the two real, valid rows must still be created");
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.results[1]!.ok, false);
  assert.ok(summary.results[1]!.message);

  const created = await prisma.product.findMany({ where: { sellerId } });
  assert.equal(created.length, 2, "exactly the two valid rows must exist — the bad row must not have left a partial product behind");
});

test("importProductsFromCsv rejects a file missing a required column, before touching the database", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  const csv = "title,description\nMissing Price Item,A real description long enough.";

  await assert.rejects(
    () => importProductsFromCsv(sellerId, csv),
    (err: unknown) => err instanceof ListingError && /Missing required column/.test(err.message),
  );

  const created = await prisma.product.count({ where: { sellerId } });
  assert.equal(created, 0);
});

test("importProductsFromCsv on a header-only file creates nothing and reports nothing, not an error", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  const summary = await importProductsFromCsv(sellerId, "title,description,sku,priceBirr,onHand\n");
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.results.length, 0);
});

test("exportSellerProductsCsv reflects real inventory, one row per variant, scoped to the real owner", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  const strangerSellerId = await makeSeller(`${suffix}-stranger`);

  await importProductsFromCsv(sellerId, [
    "title,description,sku,priceBirr,onHand",
    `Export Test Item ${suffix},A real description long enough to pass validation.,EXPORT-${suffix},75.50,8`,
  ].join("\n"));
  await importProductsFromCsv(strangerSellerId, [
    "title,description,sku,priceBirr,onHand",
    `Stranger Item ${suffix},A real description long enough to pass validation.,STRANGER-${suffix},1.00,1`,
  ].join("\n"));

  const csv = await exportSellerProductsCsv(sellerId);
  const records = parseCsvWithHeader(csv);

  assert.equal(records.length, 1, "export must be scoped to the real owner — the stranger's product must not appear");
  assert.equal(records[0]!.title, `Export Test Item ${suffix}`);
  assert.equal(records[0]!.sku, `EXPORT-${suffix}`);
  assert.equal(records[0]!.priceBirr, "75.50");
  assert.equal(records[0]!.onHand, "8");
  assert.equal(records[0]!.status, "DRAFT");
});

test("export and import round-trip: exporting a real listing and re-importing it creates a second, independent listing with the same real data", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  await importProductsFromCsv(sellerId, [
    "title,description,sku,priceBirr,onHand",
    `Round Trip Item ${suffix},A real description long enough to pass validation.,ROUNDTRIP-${suffix}-1,42.00,6`,
  ].join("\n"));

  const exported = await exportSellerProductsCsv(sellerId);
  const records = parseCsvWithHeader(exported);
  // Re-import under a different SKU (the original SKU is already taken) —
  // proves the exported CSV is itself valid, re-importable input, not just
  // a display format.
  const reimportCsv = [
    "title,description,sku,priceBirr,onHand",
    `${records[0]!.title},${records[0]!.description},ROUNDTRIP-${suffix}-2,${records[0]!.priceBirr},${records[0]!.onHand}`,
  ].join("\n");

  const summary = await importProductsFromCsv(sellerId, reimportCsv);
  assert.equal(summary.createdCount, 1, "the exported CSV must itself be valid, re-importable input");

  const all = await prisma.product.findMany({ where: { sellerId } });
  assert.equal(all.length, 2);
});

test("updateProductsFromCsv updates price/stock for a real existing SKU, leaving blank-cell fields unchanged", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  await importProductsFromCsv(sellerId, [
    "title,description,sku,priceBirr,onHand",
    `Update Test Item ${suffix},A real description long enough to pass validation.,UPD-${suffix}-1,100.00,10`,
  ].join("\n"));

  // Only sku, priceBirr, onHand filled — title/description/brand left blank.
  const summary = await updateProductsFromCsv(sellerId, [
    "sku,title,description,brand,priceBirr,onHand,status",
    `UPD-${suffix}-1,,,,75.00,3,`,
  ].join("\n"));

  assert.equal(summary.updatedCount, 1);
  assert.equal(summary.failedCount, 0);

  const product = await prisma.product.findFirstOrThrow({
    where: { sellerId, variants: { some: { sku: `UPD-${suffix}-1` } } },
    include: { variants: { include: { inventory: true } } },
  });
  assert.equal(product.title, `Update Test Item ${suffix}`, "a blank title cell must leave the real title unchanged");
  assert.equal(product.status, "DRAFT", "a blank status cell must leave the real status unchanged");
  assert.equal(product.variants[0]!.priceSantim, 7_500, "a real price cell must actually update the price");
  assert.equal(product.variants[0]!.inventory!.onHand, 3, "a real onHand cell must actually update stock");
});

test("updateProductsFromCsv rejects a SKU belonging to another seller — indistinguishable from not found", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  const strangerSellerId = await makeSeller(`${suffix}-stranger`);

  await importProductsFromCsv(strangerSellerId, [
    "title,description,sku,priceBirr,onHand",
    `Stranger Update Item ${suffix},A real description long enough to pass validation.,UPDSTRANGER-${suffix},50.00,5`,
  ].join("\n"));

  const summary = await updateProductsFromCsv(sellerId, [
    "sku,priceBirr",
    `UPDSTRANGER-${suffix},1.00`,
  ].join("\n"));

  assert.equal(summary.updatedCount, 0);
  assert.equal(summary.failedCount, 1);
  assert.match(summary.results[0]!.message ?? "", /No listing found/);

  const untouched = await prisma.variant.findFirstOrThrow({ where: { sku: `UPDSTRANGER-${suffix}` } });
  assert.equal(untouched.priceSantim, 5_000, "a cross-seller SKU attempt must not touch the real row");
});

test("updateProductsFromCsv applies a real, legal status transition and rejects an invalid status value", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  await importProductsFromCsv(sellerId, [
    "title,description,sku,priceBirr,onHand",
    `Status Test Item ${suffix},A real description long enough to pass validation.,STATUS-${suffix},20.00,4`,
  ].join("\n"));

  const publish = await updateProductsFromCsv(sellerId, [
    "sku,status",
    `STATUS-${suffix},ACTIVE`,
  ].join("\n"));
  assert.equal(publish.updatedCount, 1);
  const published = await prisma.product.findFirstOrThrow({ where: { variants: { some: { sku: `STATUS-${suffix}` } } } });
  assert.equal(published.status, "ACTIVE");

  const badStatus = await updateProductsFromCsv(sellerId, [
    "sku,status",
    `STATUS-${suffix},NOT_A_REAL_STATUS`,
  ].join("\n"));
  assert.equal(badStatus.updatedCount, 0);
  assert.equal(badStatus.failedCount, 1);
  assert.match(badStatus.results[0]!.message ?? "", /Invalid status/);
});

test("updateProductsFromCsv: a bad row does not abort the batch — good rows still update, the bad one reports a real per-row error", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  await importProductsFromCsv(sellerId, [
    "title,description,sku,priceBirr,onHand",
    `Batch A ${suffix},A real description long enough to pass validation.,BATCH-${suffix}-A,10.00,1`,
    `Batch B ${suffix},A real description long enough to pass validation.,BATCH-${suffix}-B,10.00,1`,
  ].join("\n"));

  const summary = await updateProductsFromCsv(sellerId, [
    "sku,onHand",
    `BATCH-${suffix}-A,50`,
    `NONEXISTENT-${suffix},50`,
    `BATCH-${suffix}-B,60`,
  ].join("\n"));

  assert.equal(summary.updatedCount, 2, "the two real, valid SKUs must still update");
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.results[1]!.ok, false);

  const a = await prisma.variant.findFirstOrThrow({ where: { sku: `BATCH-${suffix}-A` }, include: { inventory: true } });
  const b = await prisma.variant.findFirstOrThrow({ where: { sku: `BATCH-${suffix}-B` }, include: { inventory: true } });
  assert.equal(a.inventory!.onHand, 50);
  assert.equal(b.inventory!.onHand, 60);
});

test("updateProductsFromCsv rejects a file missing the required sku column, before touching the database", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  await importProductsFromCsv(sellerId, [
    "title,description,sku,priceBirr,onHand",
    `No Sku Column Item ${suffix},A real description long enough to pass validation.,NOSKUCOL-${suffix},10.00,1`,
  ].join("\n"));

  await assert.rejects(
    () => updateProductsFromCsv(sellerId, "title,priceBirr\nSomething,10.00"),
    (err: unknown) => err instanceof ListingError && /Missing required column: sku/.test(err.message),
  );

  const unchanged = await prisma.variant.findFirstOrThrow({ where: { sku: `NOSKUCOL-${suffix}` } });
  assert.equal(unchanged.priceSantim, 1_000);
});

test.after(async () => {
  await prisma.inventory.deleteMany({ where: { variant: { product: { seller: { slug: { startsWith: "bulk-test-seller-" } } } } } });
  await prisma.variant.deleteMany({ where: { product: { seller: { slug: { startsWith: "bulk-test-seller-" } } } } });
  await prisma.product.deleteMany({ where: { seller: { slug: { startsWith: "bulk-test-seller-" } } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "bulk-test-seller-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "bulk-test-" } } });
  await prisma.$disconnect();
});
