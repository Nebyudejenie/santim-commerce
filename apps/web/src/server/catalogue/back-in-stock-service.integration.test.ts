/**
 * Integration test — requires a real Postgres. The properties that matter
 * most: a request can only be made for a genuinely out-of-stock variant,
 * re-requesting after being notified re-arms the SAME row rather than
 * creating a duplicate (real @@unique([userId, variantId])), and
 * enqueueBackInStockCheck is a real no-op both when the variant still
 * isn't available and when nobody is actually waiting on it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  BackInStockError,
  enqueueBackInStockCheck,
  hasRequestedBackInStock,
  listPendingRequestedVariantIds,
  requestBackInStockNotification,
} from "./back-in-stock-service.ts";

const prisma = new PrismaClient();

async function makeVariant(suffix: string, onHand: number) {
  const owner = await prisma.user.create({ data: { email: `bis-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `BIS Test Seller ${suffix}`, slug: `bis-test-seller-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `bis-test-${suffix}`, title: "BIS Test Item", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `BIS-${suffix}`, title: "Default", priceSantim: 10_000 },
  });
  await prisma.inventory.create({ data: { variantId: variant.id, onHand, reserved: 0 } });
  return variant.id;
}

async function makeUser(suffix: string) {
  const user = await prisma.user.create({ data: { email: `bis-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

test("requesting a notification for a genuinely out-of-stock variant succeeds", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const variantId = await makeVariant(suffix, 0);

  await requestBackInStockNotification(userId, variantId);

  assert.equal(await hasRequestedBackInStock(userId, variantId), true);
});

test("requesting a notification for an in-stock variant is rejected", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const variantId = await makeVariant(suffix, 5);

  await assert.rejects(
    () => requestBackInStockNotification(userId, variantId),
    (err: unknown) => err instanceof BackInStockError && /already in stock/.test(err.message),
  );
});

test("re-requesting after being notified re-arms the same row instead of creating a duplicate", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const variantId = await makeVariant(suffix, 0);

  await requestBackInStockNotification(userId, variantId);
  await prisma.backInStockRequest.updateMany({ where: { userId, variantId }, data: { notifiedAt: new Date() } });
  assert.equal(await hasRequestedBackInStock(userId, variantId), false, "already-notified must not count as still-pending");

  await requestBackInStockNotification(userId, variantId); // re-request
  assert.equal(await hasRequestedBackInStock(userId, variantId), true, "re-requesting must re-arm it");

  const rows = await prisma.backInStockRequest.count({ where: { userId, variantId } });
  assert.equal(rows, 1, "re-arming must never create a second row for the same (userId, variantId)");
});

test("listPendingRequestedVariantIds returns only this user's real, still-pending requests", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const strangerId = await makeUser(`${suffix}-stranger`);
  const variantA = await makeVariant(`${suffix}-a`, 0);
  const variantB = await makeVariant(`${suffix}-b`, 0);
  const variantC = await makeVariant(`${suffix}-c`, 0);

  await requestBackInStockNotification(userId, variantA);
  await requestBackInStockNotification(userId, variantB);
  await requestBackInStockNotification(strangerId, variantC);

  const ids = await listPendingRequestedVariantIds(userId, [variantA, variantB, variantC]);
  assert.equal(ids.size, 2);
  assert.ok(ids.has(variantA));
  assert.ok(ids.has(variantB));
  assert.ok(!ids.has(variantC), "a different user's request must not leak in");
});

test("enqueueBackInStockCheck is a real no-op when the variant still has zero availability", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const variantId = await makeVariant(suffix, 0);
  await requestBackInStockNotification(userId, variantId);

  await prisma.$transaction((tx) => enqueueBackInStockCheck(tx, variantId));

  const forThis = (await prisma.outboxMessage.findMany({ where: { topic: "variant.restocked" } })).filter(
    (m) => (m.payload as { variantId: string }).variantId === variantId,
  );
  assert.equal(forThis.length, 0, "a still-zero-availability variant must never enqueue a restock notification");
});

test("enqueueBackInStockCheck is a real no-op when nobody is actually waiting on this variant", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix, 5); // in stock, but zero pending requests

  await prisma.$transaction((tx) => enqueueBackInStockCheck(tx, variantId));

  const forThis = (await prisma.outboxMessage.findMany({ where: { topic: "variant.restocked" } })).filter(
    (m) => (m.payload as { variantId: string }).variantId === variantId,
  );
  assert.equal(forThis.length, 0, "an available variant with no pending requesters must not enqueue anything");
});

test("enqueueBackInStockCheck enqueues a real message when a variant becomes available with a real pending requester", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeUser(suffix);
  const variantId = await makeVariant(suffix, 0);
  await requestBackInStockNotification(userId, variantId);

  await prisma.inventory.update({ where: { variantId }, data: { onHand: 10 } });
  await prisma.$transaction((tx) => enqueueBackInStockCheck(tx, variantId));

  const forThis = (await prisma.outboxMessage.findMany({ where: { topic: "variant.restocked" } })).filter(
    (m) => (m.payload as { variantId: string }).variantId === variantId,
  );
  assert.equal(forThis.length, 1);
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "variant.restocked" } });
  await prisma.backInStockRequest.deleteMany({ where: { variant: { product: { slug: { startsWith: "bis-test-" } } } } });
  await prisma.inventory.deleteMany({ where: { variant: { product: { slug: { startsWith: "bis-test-" } } } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "bis-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "bis-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "bis-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "bis-buyer-" } }, { email: { startsWith: "bis-seller-" } }] },
  });
  await prisma.$disconnect();
});
