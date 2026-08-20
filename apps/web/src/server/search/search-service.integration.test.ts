/**
 * Integration test — requires a real Postgres, and specifically exercises
 * `searchProducts`/`autocompleteProducts` against the real
 * `searchVector` generated column + pg_trgm index (see migration
 * 20260820134234_add_product_search_vector) — not something a unit test
 * without a database could ever verify.
 *
 * The property that matters most: search must obey the EXACT same
 * visibility rule as every other catalogue read (VISIBLE_PRODUCT_WHERE in
 * catalogue-service.ts) — a suspended seller's products, or a DRAFT
 * listing, must never surface through search even when the keywords match
 * perfectly. A search index that bypasses this would be a real, silent
 * data leak, not a cosmetic bug.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { searchProducts, autocompleteProducts } from "./search-service.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string, status: "APPROVED" | "SUSPENDED" = "APPROVED") {
  const owner = await prisma.user.create({ data: { email: `search-test-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Search Test ${suffix}`, slug: `search-test-${suffix}`, status },
  });
  return seller.id;
}

async function makeProduct(
  suffix: string,
  sellerId: string,
  opts: { title: string; brand?: string; priceSantim: number; status?: "ACTIVE" | "DRAFT" | "ARCHIVED" },
) {
  const product = await prisma.product.create({
    data: {
      sellerId,
      slug: `search-test-${suffix}`,
      title: opts.title,
      description: "A real product used only for search integration tests.",
      brand: opts.brand,
      status: opts.status ?? "ACTIVE",
    },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `ST-${suffix}`, title: "Default", priceSantim: opts.priceSantim },
  });
  await prisma.inventory.create({ data: { variantId: variant.id, onHand: 5, reserved: 0 } });
  return product.id;
}

test("a keyword search finds a product by an exact title match", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  await makeProduct(suffix, sellerId, { title: `Zephyr Windbreaker ${suffix}`, priceSantim: 10_000 });

  const result = await searchProducts({ query: `Zephyr Windbreaker ${suffix}` });
  assert.equal(result.total, 1);
  assert.equal(result.products[0]!.title, `Zephyr Windbreaker ${suffix}`);
});

test("a misspelled query still finds the product via trigram fallback — real typo tolerance", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  await makeProduct(suffix, sellerId, { title: `Corduroy Jacket ${suffix}`, priceSantim: 20_000 });

  const result = await searchProducts({ query: `Corduroy Jaket ${suffix}` }); // missing a "c"
  assert.equal(result.total, 1, "a single-letter typo must still surface the real match");
  assert.equal(result.products[0]!.title, `Corduroy Jacket ${suffix}`);
});

test("search never returns a suspended seller's products, even on a perfect keyword match", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix, "SUSPENDED");
  await makeProduct(suffix, sellerId, { title: `HiddenGoods Parka ${suffix}`, priceSantim: 30_000 });

  const result = await searchProducts({ query: `HiddenGoods Parka ${suffix}` });
  assert.equal(result.total, 0, "a suspended seller's listing must never surface through search");
});

test("search never returns a DRAFT or ARCHIVED product", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  await makeProduct(suffix, sellerId, { title: `UnpublishedDraft Vest ${suffix}`, priceSantim: 5_000, status: "DRAFT" });

  const result = await searchProducts({ query: `UnpublishedDraft Vest ${suffix}` });
  assert.equal(result.total, 0);
});

test("brand facets reflect real counts and filtering by brand narrows results correctly", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  await makeProduct(suffix, sellerId, { title: `Alpha Cap ${suffix}`, brand: `AlphaBrand${suffix}`, priceSantim: 3_000 });
  await makeProduct(`${suffix}-2`, sellerId, { title: `Alpha Beanie ${suffix}`, brand: `AlphaBrand${suffix}`, priceSantim: 4_000 });
  await makeProduct(`${suffix}-3`, sellerId, { title: `Alpha Scarf ${suffix}`, brand: `OtherBrand${suffix}`, priceSantim: 2_000 });

  const all = await searchProducts({ query: `Alpha ${suffix}` });
  assert.equal(all.total, 3);
  const alphaFacet = all.brandFacets.find((f) => f.brand === `AlphaBrand${suffix}`);
  assert.ok(alphaFacet);
  assert.equal(alphaFacet!.count, 2);

  const filtered = await searchProducts({ query: `Alpha ${suffix}`, brand: `AlphaBrand${suffix}` });
  assert.equal(filtered.total, 2);
  assert.ok(filtered.products.every((p) => p.brand === `AlphaBrand${suffix}`));
});

test("price range filtering excludes products outside the range", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  await makeProduct(suffix, sellerId, { title: `PriceRangeItem Cheap ${suffix}`, priceSantim: 1_000 });
  await makeProduct(`${suffix}-2`, sellerId, { title: `PriceRangeItem Mid ${suffix}`, priceSantim: 5_000 });
  await makeProduct(`${suffix}-3`, sellerId, { title: `PriceRangeItem Expensive ${suffix}`, priceSantim: 50_000 });

  const result = await searchProducts({ query: `PriceRangeItem ${suffix}`, minPriceSantim: 2_000, maxPriceSantim: 10_000 });
  assert.equal(result.total, 1);
  assert.equal(result.products[0]!.title, `PriceRangeItem Mid ${suffix}`);
});

test("sorting by price_asc and price_desc orders results by real minimum variant price", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  await makeProduct(suffix, sellerId, { title: `SortTest High ${suffix}`, priceSantim: 90_000 });
  await makeProduct(`${suffix}-2`, sellerId, { title: `SortTest Low ${suffix}`, priceSantim: 10_000 });
  await makeProduct(`${suffix}-3`, sellerId, { title: `SortTest Mid ${suffix}`, priceSantim: 50_000 });

  const asc = await searchProducts({ query: `SortTest ${suffix}`, sort: "price_asc" });
  assert.deepEqual(asc.products.map((p) => p.title), [
    `SortTest Low ${suffix}`,
    `SortTest Mid ${suffix}`,
    `SortTest High ${suffix}`,
  ]);

  const desc = await searchProducts({ query: `SortTest ${suffix}`, sort: "price_desc" });
  assert.deepEqual(desc.products.map((p) => p.title), [
    `SortTest High ${suffix}`,
    `SortTest Mid ${suffix}`,
    `SortTest Low ${suffix}`,
  ]);
});

test("pagination returns the real total count and non-overlapping pages", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  for (let i = 0; i < 5; i++) {
    await makeProduct(`${suffix}-${i}`, sellerId, { title: `PageTest Item ${i} ${suffix}`, priceSantim: 1_000 * (i + 1) });
  }

  const page1 = await searchProducts({ query: `PageTest ${suffix}`, sort: "price_asc", page: 1, pageSize: 2 });
  const page2 = await searchProducts({ query: `PageTest ${suffix}`, sort: "price_asc", page: 2, pageSize: 2 });
  const page3 = await searchProducts({ query: `PageTest ${suffix}`, sort: "price_asc", page: 3, pageSize: 2 });

  assert.equal(page1.total, 5);
  assert.equal(page2.total, 5);
  assert.equal(page1.products.length, 2);
  assert.equal(page2.products.length, 2);
  assert.equal(page3.products.length, 1);

  const allIds = [...page1.products, ...page2.products, ...page3.products].map((p) => p.id);
  assert.equal(new Set(allIds).size, 5, "pages must not overlap or drop a real result");
});

test("autocomplete suggests a real product by prefix and never leaks a suspended seller's product", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const visibleSellerId = await makeSeller(`${suffix}-vis`);
  const suspendedSellerId = await makeSeller(`${suffix}-susp`, "SUSPENDED");
  await makeProduct(suffix, visibleSellerId, { title: `Autocompleteable Hoodie ${suffix}`, priceSantim: 8_000 });
  await makeProduct(`${suffix}-hidden`, suspendedSellerId, { title: `Autocompleteable Ghost ${suffix}`, priceSantim: 9_000 });

  const suggestions = await autocompleteProducts(`Autocompleteable`);
  const titles = suggestions.map((s) => s.title);
  assert.ok(titles.includes(`Autocompleteable Hoodie ${suffix}`));
  assert.ok(!titles.includes(`Autocompleteable Ghost ${suffix}`), "a suspended seller's product must not autocomplete");
});

test("autocomplete returns nothing for a query shorter than 2 characters", async () => {
  assert.deepEqual(await autocompleteProducts("a"), []);
  assert.deepEqual(await autocompleteProducts(""), []);
});

test.after(async () => {
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "search-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "search-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "search-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "search-test-" } } });
  await prisma.$disconnect();
});
