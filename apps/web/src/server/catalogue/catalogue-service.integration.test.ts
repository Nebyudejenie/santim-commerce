/**
 * Integration test — requires a real Postgres. First dedicated coverage
 * for this module, focused on `listRelatedProducts` (cross-sell on the
 * product page, confirmed absent before this feature): excludes the
 * product itself, scopes to the SAME seller only, and respects the same
 * visibility rule (`VISIBLE_PRODUCT_WHERE`) every other browsing query in
 * this file already enforces — a suspended seller or an unpublished
 * listing must never show up as "more from this seller".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { listRelatedProducts } from "./catalogue-service.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string, status: "APPROVED" | "SUSPENDED" = "APPROVED") {
  const owner = await prisma.user.create({ data: { email: `related-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Related Test Seller ${suffix}`, slug: `related-test-seller-${suffix}`, status },
  });
  return seller.id;
}

async function makeProduct(sellerId: string, suffix: string, status: "ACTIVE" | "DRAFT" = "ACTIVE") {
  return prisma.product.create({
    data: { sellerId, slug: `related-test-${suffix}`, title: `Related Test Item ${suffix}`, description: "d", status },
  });
}

test("listRelatedProducts returns other visible products from the same seller, excluding the product itself", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  const productA = await makeProduct(sellerId, `${suffix}-a`);
  const productB = await makeProduct(sellerId, `${suffix}-b`);
  const productC = await makeProduct(sellerId, `${suffix}-c`);

  const related = await listRelatedProducts(sellerId, productA.id);

  assert.equal(related.length, 2);
  const ids = related.map((p) => p.id);
  assert.ok(ids.includes(productB.id));
  assert.ok(ids.includes(productC.id));
  assert.ok(!ids.includes(productA.id), "a product must never recommend itself");
});

test("listRelatedProducts never includes a different seller's products", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerA = await makeSeller(`${suffix}-a`);
  const sellerB = await makeSeller(`${suffix}-b`);
  const productA = await makeProduct(sellerA, `${suffix}-a`);
  await makeProduct(sellerB, `${suffix}-b`);

  const related = await listRelatedProducts(sellerA, productA.id);

  assert.equal(related.length, 0, "a different seller's product must never appear as \"more from this seller\"");
});

test("listRelatedProducts excludes a DRAFT (unpublished) listing from the same seller", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  const productA = await makeProduct(sellerId, `${suffix}-a`);
  await makeProduct(sellerId, `${suffix}-draft`, "DRAFT");

  const related = await listRelatedProducts(sellerId, productA.id);

  assert.equal(related.length, 0, "an unpublished sibling listing must not be recommended");
});

test("listRelatedProducts excludes every product from a seller that's since been suspended", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  const productA = await makeProduct(sellerId, `${suffix}-a`);
  await makeProduct(sellerId, `${suffix}-b`);
  await prisma.seller.update({ where: { id: sellerId }, data: { status: "SUSPENDED" } });

  const related = await listRelatedProducts(sellerId, productA.id);

  assert.equal(related.length, 0, "a suspended seller's other listings must not be recommended either");
});

test("listRelatedProducts respects the take limit", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  const productA = await makeProduct(sellerId, `${suffix}-a`);
  for (let i = 0; i < 5; i++) {
    await makeProduct(sellerId, `${suffix}-extra-${i}`);
  }

  const related = await listRelatedProducts(sellerId, productA.id, 3);
  assert.equal(related.length, 3);
});

test.after(async () => {
  await prisma.product.deleteMany({ where: { slug: { startsWith: "related-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "related-test-seller-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "related-seller-" } } });
  await prisma.$disconnect();
});
