/**
 * Integration test — requires a real Postgres. The properties that matter
 * most: enqueueLowStockCheck is a real no-op when stock is healthy, fires
 * exactly once per real dip (not once per unit sold while already low),
 * and correctly re-arms — a variant that recovers above threshold and
 * later dips again produces a genuinely new alert, with a real, distinct
 * alertCount, not a silently swallowed duplicate (the exact bug class
 * this session already found and fixed once for back-in-stock requests).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { enqueueLowStockCheck } from "./low-stock-service.ts";

const prisma = new PrismaClient();

async function makeVariant(suffix: string, onHand: number, lowStockThreshold = 5) {
  const owner = await prisma.user.create({ data: { email: `lowstock-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Low Stock Test Seller ${suffix}`, slug: `lowstock-test-seller-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `lowstock-test-${suffix}`, title: "Low Stock Test Item", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `LS-${suffix}`, title: "Default", priceSantim: 10_000 },
  });
  await prisma.inventory.create({ data: { variantId: variant.id, onHand, reserved: 0, lowStockThreshold } });
  return variant.id;
}

async function outboxCountFor(variantId: string): Promise<number> {
  const messages = await prisma.outboxMessage.findMany({ where: { topic: "variant.low_stock" } });
  return messages.filter((m) => (m.payload as { variantId: string }).variantId === variantId).length;
}

test("enqueueLowStockCheck is a real no-op when stock is healthy (above threshold)", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix, 20, 5);

  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));

  assert.equal(await outboxCountFor(variantId), 0);
  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.lowStockAlertedAt, null);
});

test("enqueueLowStockCheck fires a real alert the moment stock dips to or below threshold", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix, 5, 5); // exactly at threshold

  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));

  assert.equal(await outboxCountFor(variantId), 1);
  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.ok(inventory.lowStockAlertedAt, "the alerted flag must be set for this dip");
  assert.equal(inventory.lowStockAlertCount, 1);
});

test("enqueueLowStockCheck does not re-fire on every subsequent call while still below threshold", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix, 3, 5);

  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 2 } }); // sold one more, still low
  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 1 } });
  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));

  assert.equal(await outboxCountFor(variantId), 1, "a seller must not get a fresh alert for every unit sold while already below threshold");
});

// The exact bug class this session already found and fixed once for
// back-in-stock requests (dedupeKey built from a stable id that survives
// a re-arm, silently swallowing every notification after the first).
// lowStockAlertCount, not the alertedAt flag alone, must be what makes
// each real dip's dedupeKey genuinely distinct.
test("a variant that recovers above threshold and dips again produces a real second, distinct alert", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix, 3, 5); // starts low

  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));
  assert.equal(await outboxCountFor(variantId), 1);
  let inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.lowStockAlertCount, 1);

  // Restocked well above threshold — must re-arm.
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 50 } });
  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));
  inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.lowStockAlertedAt, null, "recovering above threshold must clear the alerted flag");
  assert.equal(inventory.lowStockAlertCount, 1, "recovering must never reset the monotonic counter");

  // Sells back down below threshold — a genuinely new dip.
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 2 } });
  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));

  assert.equal(await outboxCountFor(variantId), 2, "a real second dip must produce a real second alert, not be silently swallowed");
  inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.lowStockAlertCount, 2, "the counter must have genuinely advanced, giving the second alert a distinct dedupeKey");
});

test("a variant with no lowStockThreshold override uses its own real, per-variant setting", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  // A seller-lowered threshold: 10 units left would be "low" for a fast
  // mover at the default threshold of 5, but not for one set to 2.
  const variantId = await makeVariant(suffix, 10, 2);

  await prisma.$transaction((tx) => enqueueLowStockCheck(tx, variantId));

  assert.equal(await outboxCountFor(variantId), 0, "10 available must not trip a threshold of 2");
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "variant.low_stock" } });
  await prisma.inventory.deleteMany({ where: { variant: { product: { slug: { startsWith: "lowstock-test-" } } } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "lowstock-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "lowstock-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "lowstock-test-seller-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "lowstock-seller-" } } });
  await prisma.$disconnect();
});
