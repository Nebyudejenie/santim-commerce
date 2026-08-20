/**
 * Integration test — requires a real Postgres. The property that matters
 * most here is the multi-seller aggregate: a real order with lines from
 * TWO different sellers, where fulfilling one seller's line must move the
 * ORDER to PARTIALLY_FULFILLED (not FULFILLED — the other seller's item
 * hasn't shipped) — this is exactly the scenario a single Order-level
 * fulfilmentStatus field could never represent, which is the entire reason
 * this feature exists. Same cross-seller-authorization discipline as
 * every other seller-scoped mutation this session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { FulfilmentError, markLineFulfilled, markLineUnfulfilled } from "./seller-order-fulfillment.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `fulfil-test-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Fulfil Test ${suffix}`, slug: `fulfil-test-${suffix}`, status: "APPROVED" },
  });
  return seller.id;
}

async function makeSingleSellerOrder(sellerId: string, suffix: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-FULFIL${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 1000,
      totalSantim: 1000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `F-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 1000, quantity: 1, lineTotalSantim: 1000 },
        ],
      },
    },
    include: { lines: true },
  });
  return { orderId: order.id, lineId: order.lines[0]!.id };
}

test("marking the only line fulfilled moves the order to FULFILLED", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  const { orderId, lineId } = await makeSingleSellerOrder(sellerId, suffix);

  await markLineFulfilled(sellerId, lineId);

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(order.fulfilmentStatus, "FULFILLED");
  assert.equal(line.fulfilmentStatus, "FULFILLED");
  assert.ok(line.fulfilledAt);
});

test("undoing a fulfilled line moves the order back to UNFULFILLED", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`undo-${suffix}`);
  const { orderId, lineId } = await makeSingleSellerOrder(sellerId, `undo-${suffix}`);

  await markLineFulfilled(sellerId, lineId);
  await markLineUnfulfilled(sellerId, lineId);

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(order.fulfilmentStatus, "UNFULFILLED");
  assert.equal(line.fulfilmentStatus, "UNFULFILLED");
  assert.equal(line.fulfilledAt, null);
});

test("a MULTI-SELLER order: seller A fulfilling their line moves the order to PARTIALLY_FULFILLED, not FULFILLED, because seller B's line hasn't shipped", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerA = await makeSeller(`multi-a-${suffix}`);
  const sellerB = await makeSeller(`multi-b-${suffix}`);

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-FULFILMULTI${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 2000,
      totalSantim: 2000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId: sellerA, sku: `FA-${suffix}`, productTitle: "A's item", variantTitle: "Default", unitPriceSantim: 1000, quantity: 1, lineTotalSantim: 1000 },
          { sellerId: sellerB, sku: `FB-${suffix}`, productTitle: "B's item", variantTitle: "Default", unitPriceSantim: 1000, quantity: 1, lineTotalSantim: 1000 },
        ],
      },
    },
    include: { lines: true },
  });
  const lineA = order.lines.find((l) => l.sellerId === sellerA)!;
  const lineB = order.lines.find((l) => l.sellerId === sellerB)!;

  await markLineFulfilled(sellerA, lineA.id);

  const afterA = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(afterA.fulfilmentStatus, "PARTIALLY_FULFILLED", "one seller shipping their item is not the whole order fulfilled");

  await markLineFulfilled(sellerB, lineB.id);

  const afterBoth = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(afterBoth.fulfilmentStatus, "FULFILLED", "once BOTH sellers have shipped, the order is genuinely fulfilled");
});

test("seller B CANNOT mark seller A's line fulfilled, even with the real orderLineId", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerA = await makeSeller(`cross-a-${suffix}`);
  const sellerB = await makeSeller(`cross-b-${suffix}`);
  const { lineId } = await makeSingleSellerOrder(sellerA, `cross-${suffix}`);

  await assert.rejects(() => markLineFulfilled(sellerB, lineId), FulfilmentError);

  const untouched = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(untouched.fulfilmentStatus, "UNFULFILLED", "the cross-seller attempt must not have changed anything");
});

test("marking a line fulfilled enqueues a real outbox message, but undoing it does not", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`outbox-${suffix}`);
  const { lineId } = await makeSingleSellerOrder(sellerId, `outbox-${suffix}`);

  await markLineFulfilled(sellerId, lineId);

  const messages = await prisma.outboxMessage.findMany({ where: { topic: "order.line_fulfilled" } });
  const forThisLine = messages.filter((m) => (m.payload as { orderLineId: string }).orderLineId === lineId);
  assert.equal(forThisLine.length, 1, "fulfilling a line must enqueue exactly one order.line_fulfilled message");

  await markLineUnfulfilled(sellerId, lineId);
  const afterUndo = await prisma.outboxMessage.findMany({ where: { topic: "order.line_fulfilled" } });
  const stillForThisLine = afterUndo.filter((m) => (m.payload as { orderLineId: string }).orderLineId === lineId);
  assert.equal(stillForThisLine.length, 1, "undoing a fulfilment must not enqueue a second message for the same line");
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "order.line_fulfilled" } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-FULFIL" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-FULFIL" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "fulfil-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "fulfil-test-" } } });
  await prisma.$disconnect();
});
