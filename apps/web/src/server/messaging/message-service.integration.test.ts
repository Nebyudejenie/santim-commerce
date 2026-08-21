/**
 * Integration test — requires a real Postgres. Covers the two real
 * authorization boundaries this feature depends on (a buyer can only open
 * a thread with a seller who actually has a line in THEIR OWN order; a
 * seller can only open/reply to a thread for an order they actually sold
 * into), the guest-order refusal, per-side unread computation, and the
 * multi-vendor case (one order, two sellers, two independent threads).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  getOrCreateThreadForBuyer,
  getOrCreateThreadForSeller,
  getThreadForBuyer,
  getThreadForSeller,
  listThreadsForBuyer,
  listThreadsForSeller,
  markThreadReadByBuyer,
  markThreadReadBySeller,
  MessagingError,
  sendBuyerMessage,
  sendSellerMessage,
} from "./message-service.ts";

const prisma = new PrismaClient();

async function makeBuyer(suffix: string) {
  const user = await prisma.user.create({ data: { email: `msg-buyer-${suffix}@example.et`, name: "Test Buyer", role: "CUSTOMER" } });
  return user.id;
}

async function makeSellerWithProduct(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `msg-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Msg Test Seller ${suffix}`, slug: `msg-test-seller-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `msg-test-${suffix}`, title: "Msg Test Item", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `MT-${suffix}`, title: "Default", priceSantim: 10_000 },
  });
  return { ownerId: owner.id, sellerId: seller.id, variantId: variant.id };
}

async function makeOrder(
  suffix: string,
  userId: string | null,
  lines: { sellerId: string; variantId: string }[],
) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-MSG-${suffix}`.toUpperCase(),
      userId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000 * lines.length,
      totalSantim: 10_000 * lines.length,
      paidAt: new Date(),
      lines: {
        create: lines.map((l, i) => ({
          variantId: l.variantId,
          sellerId: l.sellerId,
          sku: `MT-${suffix}-${i}`,
          productTitle: "Msg Test Item",
          variantTitle: "Default",
          unitPriceSantim: 10_000,
          quantity: 1,
          lineTotalSantim: 10_000,
        })),
      },
    },
  });
  return order.id;
}

test("getOrCreateThreadForBuyer opens a real thread for the order's real owner and a seller who really sold into it", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const thread = await getOrCreateThreadForBuyer(userId, order.orderNumber, sellerId);
  assert.ok(thread);

  const row = await prisma.messageThread.findUniqueOrThrow({ where: { id: thread!.id } });
  assert.equal(row.buyerUserId, userId);
  assert.equal(row.sellerId, sellerId);
  assert.ok(row.buyerLastReadAt, "opening as buyer marks the buyer's own side read");
});

test("getOrCreateThreadForBuyer is idempotent — opening twice returns the SAME thread, not a duplicate", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const first = await getOrCreateThreadForBuyer(userId, order.orderNumber, sellerId);
  const second = await getOrCreateThreadForBuyer(userId, order.orderNumber, sellerId);
  assert.equal(first!.id, second!.id);

  const count = await prisma.messageThread.count({ where: { orderId, sellerId } });
  assert.equal(count, 1);
});

test("getOrCreateThreadForBuyer refuses another user's order — indistinguishable from not found", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const otherUserId = await makeBuyer(`${suffix}-other`);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const thread = await getOrCreateThreadForBuyer(otherUserId, order.orderNumber, sellerId);
  assert.equal(thread, null);
});

test("getOrCreateThreadForBuyer refuses a seller with no real line in this order", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { sellerId: unrelatedSellerId } = await makeSellerWithProduct(`${suffix}-unrelated`);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const thread = await getOrCreateThreadForBuyer(userId, order.orderNumber, unrelatedSellerId);
  assert.equal(thread, null);
});

test("getOrCreateThreadForSeller opens a real thread for a seller who really sold into this order", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const thread = await getOrCreateThreadForSeller(sellerId, order.orderNumber);
  assert.ok(thread);

  const row = await prisma.messageThread.findUniqueOrThrow({ where: { id: thread!.id } });
  assert.equal(row.buyerUserId, userId);
  assert.ok(row.sellerLastReadAt, "opening as seller marks the seller's own side read");
});

test("getOrCreateThreadForSeller refuses a guest order — no account to message", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, null, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const thread = await getOrCreateThreadForSeller(sellerId, order.orderNumber);
  assert.equal(thread, null);
});

test("getOrCreateThreadForSeller refuses a seller who has no line in this order", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { sellerId: unrelatedSellerId } = await makeSellerWithProduct(`${suffix}-unrelated`);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const thread = await getOrCreateThreadForSeller(unrelatedSellerId, order.orderNumber);
  assert.equal(thread, null);
});

test("a real multi-vendor order gets two independent threads, one per seller, no cross-contamination", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const a = await makeSellerWithProduct(`${suffix}-a`);
  const b = await makeSellerWithProduct(`${suffix}-b`);
  const orderId = await makeOrder(suffix, userId, [
    { sellerId: a.sellerId, variantId: a.variantId },
    { sellerId: b.sellerId, variantId: b.variantId },
  ]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const threadA = await getOrCreateThreadForBuyer(userId, order.orderNumber, a.sellerId);
  const threadB = await getOrCreateThreadForBuyer(userId, order.orderNumber, b.sellerId);
  assert.ok(threadA && threadB);
  assert.notEqual(threadA!.id, threadB!.id);

  await sendBuyerMessage(userId, threadA!.id, "Hello seller A");

  const detailA = await getThreadForSeller(a.sellerId, threadA!.id);
  const detailB = await getThreadForSeller(b.sellerId, threadB!.id);
  assert.equal(detailA!.messages.length, 1);
  assert.equal(detailB!.messages.length, 0, "seller B's thread must not see seller A's message");

  // Seller B must never be able to read seller A's thread by id.
  const crossRead = await getThreadForSeller(b.sellerId, threadA!.id);
  assert.equal(crossRead, null);
});

test("sendBuyerMessage creates a real message and rejects an empty body", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const thread = await getOrCreateThreadForBuyer(userId, order.orderNumber, sellerId);

  await sendBuyerMessage(userId, thread!.id, "Where's my package?");
  const detail = await getThreadForBuyer(userId, thread!.id);
  assert.equal(detail!.messages.length, 1);
  assert.equal(detail!.messages[0]!.body, "Where's my package?");
  assert.equal(detail!.messages[0]!.senderUserId, userId);

  await assert.rejects(() => sendBuyerMessage(userId, thread!.id, "   "), MessagingError);
});

test("sendBuyerMessage refuses a threadId that isn't this buyer's own — indistinguishable from not found", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const otherUserId = await makeBuyer(`${suffix}-other`);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const thread = await getOrCreateThreadForBuyer(userId, order.orderNumber, sellerId);

  await assert.rejects(() => sendBuyerMessage(otherUserId, thread!.id, "not my thread"), MessagingError);
});

test("sendSellerMessage creates a real message and enforces seller ownership", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { ownerId, sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { sellerId: unrelatedSellerId } = await makeSellerWithProduct(`${suffix}-unrelated`);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const thread = await getOrCreateThreadForSeller(sellerId, order.orderNumber);

  await sendSellerMessage(sellerId, ownerId, thread!.id, "It ships tomorrow.");
  const detail = await getThreadForSeller(sellerId, thread!.id);
  assert.equal(detail!.messages.length, 1);
  assert.equal(detail!.messages[0]!.senderUserId, ownerId);

  // A different seller must never be able to reply into this thread.
  await assert.rejects(
    () => sendSellerMessage(unrelatedSellerId, ownerId, thread!.id, "not my thread"),
    MessagingError,
  );
});

test("per-side unread computation: a reply is unread for the recipient until they read it, never for the sender", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { ownerId, sellerId, variantId } = await makeSellerWithProduct(suffix);
  const orderId = await makeOrder(suffix, userId, [{ sellerId, variantId }]);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const thread = await getOrCreateThreadForBuyer(userId, order.orderNumber, sellerId);

  await sendBuyerMessage(userId, thread!.id, "Hi, is this in stock?");

  let buyerInbox = await listThreadsForBuyer(userId);
  let sellerInbox = await listThreadsForSeller(sellerId);
  assert.equal(buyerInbox.find((t) => t.id === thread!.id)!.unread, false, "sender's own message is never unread to them");
  assert.equal(sellerInbox.find((t) => t.id === thread!.id)!.unread, true, "recipient sees it as unread");

  await markThreadReadBySeller(sellerId, thread!.id);
  sellerInbox = await listThreadsForSeller(sellerId);
  assert.equal(sellerInbox.find((t) => t.id === thread!.id)!.unread, false, "marking read clears it");

  await sendSellerMessage(sellerId, ownerId, thread!.id, "Yes, in stock.");
  buyerInbox = await listThreadsForBuyer(userId);
  assert.equal(buyerInbox.find((t) => t.id === thread!.id)!.unread, true, "the seller's reply is now unread for the buyer");

  await markThreadReadByBuyer(userId, thread!.id);
  buyerInbox = await listThreadsForBuyer(userId);
  assert.equal(buyerInbox.find((t) => t.id === thread!.id)!.unread, false);
});

test.after(async () => {
  await prisma.message.deleteMany({ where: { thread: { order: { orderNumber: { startsWith: "SC-MSG-" } } } } });
  await prisma.messageThread.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-MSG-" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-MSG-" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-MSG-" } } });
  await prisma.inventory.deleteMany({ where: { variant: { product: { slug: { startsWith: "msg-test-" } } } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "msg-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "msg-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "msg-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "msg-buyer-" } }, { email: { startsWith: "msg-seller-" } }] },
  });
  await prisma.$disconnect();
});
