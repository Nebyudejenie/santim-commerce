/**
 * Integration test — requires a real Postgres. The properties that matter
 * most: a repeat view updates recency in place rather than creating a
 * duplicate row (the real @@unique([userId, productId]) constraint makes
 * this an upsert, not an append-only log), ordering is real most-recent-
 * first, and an item that's since become unavailable (unpublished,
 * suspended seller) is silently excluded — the opposite choice from
 * wishlist, deliberate: a passively recorded view isn't a save-intent
 * worth surfacing once it's no longer buyable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { listRecentlyViewed, recordView } from "./recently-viewed-service.ts";

const prisma = new PrismaClient();

async function makeUser(suffix: string) {
  const user = await prisma.user.create({ data: { email: `rv-test-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

async function makeProduct(suffix: string, status: "ACTIVE" | "DRAFT" = "ACTIVE", sellerStatus: "APPROVED" | "SUSPENDED" = "APPROVED") {
  const owner = await prisma.user.create({ data: { email: `rv-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `RV Test Seller ${suffix}`, slug: `rv-test-seller-${suffix}`, status: sellerStatus },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `rv-test-${suffix}`, title: `RV Test Item ${suffix}`, description: "d", status },
  });
  return product.id;
}

test("viewing a product records it, most recent first", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productA = await makeProduct(`${suffix}-a`);
  const productB = await makeProduct(`${suffix}-b`);

  await recordView(userId, productA);
  await recordView(userId, productB);

  const list = await listRecentlyViewed(userId);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.productId, productB, "the most recently viewed product must come first");
  assert.equal(list[1]!.productId, productA);
});

test("viewing the same product twice updates recency in place — no duplicate row", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productA = await makeProduct(`${suffix}-a`);
  const productB = await makeProduct(`${suffix}-b`);

  await recordView(userId, productA);
  await recordView(userId, productB);
  await recordView(userId, productA); // re-view A — it should jump back to the front

  const list = await listRecentlyViewed(userId);
  assert.equal(list.length, 2, "re-viewing must never create a duplicate row for the same product");
  assert.equal(list[0]!.productId, productA, "re-viewing must bump it back to most-recent");

  const rows = await prisma.recentlyViewed.count({ where: { userId, productId: productA } });
  assert.equal(rows, 1);
});

test("touchSeq — not viewedAt or id — is what makes a re-viewed row rank correctly", async () => {
  // Direct regression test for a real bug: ordering by [viewedAt desc, id
  // desc] is wrong once a row is UPDATED rather than created, because an
  // upsert's update branch never changes `id` — an older row (smaller id)
  // that's re-viewed NOW can still lose a viewedAt tie against a newer,
  // untouched row (larger id). touchSeq must be strictly greater on A
  // after its re-view than B's, even though A's row id is smaller.
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productA = await makeProduct(`${suffix}-a`);
  const productB = await makeProduct(`${suffix}-b`);

  await recordView(userId, productA);
  await recordView(userId, productB);
  await recordView(userId, productA);

  const rowA = await prisma.recentlyViewed.findUniqueOrThrow({ where: { userId_productId: { userId, productId: productA } } });
  const rowB = await prisma.recentlyViewed.findUniqueOrThrow({ where: { userId_productId: { userId, productId: productB } } });

  assert.ok(rowA.id < rowB.id, "sanity check: A's row id really is smaller — it was created first");
  assert.ok(rowA.touchSeq > rowB.touchSeq, "A's touchSeq must be greater — it was touched most recently, regardless of row id");
});

test("listRecentlyViewed excludes a product that's since become unavailable", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productId = await makeProduct(suffix, "ACTIVE");

  await recordView(userId, productId);
  await prisma.product.update({ where: { id: productId }, data: { status: "DRAFT" } });

  const list = await listRecentlyViewed(userId);
  assert.equal(list.length, 0, "a passively viewed item that's no longer buyable must not be surfaced");
});

test("excludeProductId omits the current product — for a real PDP not recommending itself", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productA = await makeProduct(`${suffix}-a`);
  const productB = await makeProduct(`${suffix}-b`);

  await recordView(userId, productA);
  await recordView(userId, productB);

  const list = await listRecentlyViewed(userId, productB);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.productId, productA);
});

test("recently viewed is scoped to its own user", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userA = await makeUser(`${suffix}-a`);
  const userB = await makeUser(`${suffix}-b`);
  const productId = await makeProduct(suffix);

  await recordView(userA, productId);

  assert.equal((await listRecentlyViewed(userA)).length, 1);
  assert.equal((await listRecentlyViewed(userB)).length, 0);
});

test.after(async () => {
  await prisma.recentlyViewed.deleteMany({ where: { product: { slug: { startsWith: "rv-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "rv-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "rv-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "rv-test-" } }, { email: { startsWith: "rv-seller-" } }] },
  });
  await prisma.$disconnect();
});
