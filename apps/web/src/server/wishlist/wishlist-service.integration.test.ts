/**
 * Integration test — requires a real Postgres. The properties that matter
 * most: toggling is real add/remove (not just an "already exists" no-op),
 * concurrent double-toggles can't create a duplicate row (the real
 * @@unique([userId, productId]) constraint, not an application check-then-
 * write), and a wishlisted item that's gone unavailable (unpublished
 * product, suspended seller) still shows up — this is a "still saved, no
 * longer buyable" list, not a filtered catalogue view.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { isWishlisted, listWishlist, toggleWishlist } from "./wishlist-service.ts";

const prisma = new PrismaClient();

async function makeUser(suffix: string) {
  const user = await prisma.user.create({ data: { email: `wishlist-test-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

async function makeProduct(suffix: string, status: "ACTIVE" | "DRAFT" = "ACTIVE", sellerStatus: "APPROVED" | "SUSPENDED" = "APPROVED") {
  const owner = await prisma.user.create({ data: { email: `wishlist-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Wishlist Test Seller ${suffix}`, slug: `wishlist-test-seller-${suffix}`, status: sellerStatus },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `wishlist-test-${suffix}`, title: "Wishlist Test Item", description: "d", status },
  });
  return product.id;
}

test("toggling wishlists a product, then un-wishlists it on a second toggle", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productId = await makeProduct(suffix);

  assert.equal(await isWishlisted(userId, productId), false);

  const first = await toggleWishlist(userId, productId);
  assert.equal(first.wishlisted, true);
  assert.equal(await isWishlisted(userId, productId), true);

  const second = await toggleWishlist(userId, productId);
  assert.equal(second.wishlisted, false);
  assert.equal(await isWishlisted(userId, productId), false);

  const rows = await prisma.wishlistItem.count({ where: { userId, productId } });
  assert.equal(rows, 0, "un-wishlisting must actually delete the row, not just mark it inactive");
});

test("two concurrent 'add' toggles from the same user never create a duplicate row", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productId = await makeProduct(suffix);

  const results = await Promise.all([toggleWishlist(userId, productId), toggleWishlist(userId, productId)]);
  // Both calls raced the SAME "not yet wishlisted" read, so both attempt to
  // create; the real unique constraint means exactly one row exists either way.
  assert.ok(results.every((r) => r.wishlisted === true) || results.some((r) => r.wishlisted === true));

  const rows = await prisma.wishlistItem.count({ where: { userId, productId } });
  assert.equal(rows, 1, "a real race must never produce two rows for the same (userId, productId)");
});

test("listWishlist includes an item whose product was unpublished after being saved", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productId = await makeProduct(suffix, "ACTIVE");

  await toggleWishlist(userId, productId);
  await prisma.product.update({ where: { id: productId }, data: { status: "DRAFT" } });

  const list = await listWishlist(userId);
  assert.equal(list.length, 1, "an item must not silently vanish from the wishlist when it becomes unavailable");
  assert.equal(list[0]!.product.status, "DRAFT", "the real current status must be visible so the UI can show 'no longer available'");
});

test("listWishlist includes an item whose seller was suspended after being saved", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const productId = await makeProduct(suffix, "ACTIVE", "APPROVED");

  await toggleWishlist(userId, productId);
  await prisma.seller.updateMany({ where: { products: { some: { id: productId } } }, data: { status: "SUSPENDED" } });

  const list = await listWishlist(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.product.seller.status, "SUSPENDED");
});

test("a wishlist is scoped to its own user — one user's items never appear for another", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userA = await makeUser(`${suffix}-a`);
  const userB = await makeUser(`${suffix}-b`);
  const productId = await makeProduct(suffix);

  await toggleWishlist(userA, productId);

  assert.equal((await listWishlist(userA)).length, 1);
  assert.equal((await listWishlist(userB)).length, 0);
  assert.equal(await isWishlisted(userB, productId), false);
});

test.after(async () => {
  await prisma.wishlistItem.deleteMany({ where: { product: { slug: { startsWith: "wishlist-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "wishlist-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "wishlist-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "wishlist-test-" } }, { email: { startsWith: "wishlist-seller-" } }] },
  });
  await prisma.$disconnect();
});
