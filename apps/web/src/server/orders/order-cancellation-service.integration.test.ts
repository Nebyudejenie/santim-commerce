/**
 * Integration test — requires a real Postgres. The properties that matter
 * most: a PENDING_PAYMENT cancellation releases the real HELD reservation;
 * a PAID cancellation restocks real inventory and reverses real
 * settlement via a REFUND entry, the exact same ledger discipline as
 * return-service.ts; an order that's already started shipping (even
 * partially) can never be cancelled — the customer must use returns
 * instead; and ownership is real — a stranger's orderNumber guess gets
 * the same "not found" a genuine typo would.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { cancelOrder, OrderCancellationError } from "./order-cancellation-service.ts";
import { createLedgerEntriesForOrder, getSellerBalance } from "./settlement-service.ts";

const prisma = new PrismaClient();

async function makeSellerBuyerVariant(suffix: string) {
  const sellerOwner = await prisma.user.create({ data: { email: `cancel-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: sellerOwner.id, storeName: `Cancel Test Seller ${suffix}`, slug: `cancel-test-seller-${suffix}`, status: "APPROVED", commissionBps: 1000 },
  });
  const buyer = await prisma.user.create({ data: { email: `cancel-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `cancel-test-product-${suffix}`, title: "Cancel Test Product", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({ data: { productId: product.id, sku: `CX-${suffix}`, title: "Default", priceSantim: 10_000 } });
  await prisma.inventory.create({ data: { variantId: variant.id, onHand: 10, reserved: 0 } });
  return { sellerId: seller.id, buyerId: buyer.id, variantId: variant.id };
}

async function makePendingPaymentOrder(suffix: string, buyerId: string, sellerId: string, variantId: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-CANCEL${suffix}`.toUpperCase(),
      userId: buyerId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PENDING_PAYMENT",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      lines: {
        create: [
          { variantId, sellerId, sku: `CX-${suffix}`, productTitle: "Cancel Test Product", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
        ],
      },
    },
    include: { lines: true },
  });
  await prisma.inventory.update({ where: { variantId }, data: { reserved: { increment: 1 } } });
  await prisma.inventoryReservation.create({
    data: { orderId: order.id, variantId, quantity: 1, status: "HELD", expiresAt: new Date(Date.now() + 20 * 60_000) },
  });
  return { orderId: order.id, orderNumber: order.orderNumber, lineId: order.lines[0]!.id };
}

async function makePaidOrder(suffix: string, buyerId: string, sellerId: string, variantId: string, fulfilmentStatus: "UNFULFILLED" | "FULFILLED" | "PARTIALLY_FULFILLED" = "UNFULFILLED") {
  // A real payment commits the reservation: onHand decremented for real.
  await prisma.inventory.update({ where: { variantId }, data: { onHand: { decrement: 1 } } });
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-CANCEL${suffix}`.toUpperCase(),
      userId: buyerId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: new Date(),
      fulfilmentStatus,
      lines: {
        create: [
          {
            variantId, sellerId, sku: `CX-${suffix}`, productTitle: "Cancel Test Product", variantTitle: "Default",
            unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000,
            fulfilmentStatus: fulfilmentStatus === "UNFULFILLED" ? "UNFULFILLED" : "FULFILLED",
          },
        ],
      },
    },
    include: { lines: true },
  });
  await createLedgerEntriesForOrder(order.id);
  return { orderId: order.id, orderNumber: order.orderNumber, lineId: order.lines[0]!.id };
}

test("cancelling a PENDING_PAYMENT order releases the real held reservation", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, sellerId, variantId } = await makeSellerBuyerVariant(suffix);
  const { orderNumber } = await makePendingPaymentOrder(suffix, buyerId, sellerId, variantId);

  const before = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(before.reserved, 1);

  await cancelOrder(buyerId, orderNumber);

  const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber } });
  assert.equal(order.status, "CANCELLED");
  assert.ok(order.cancelledAt);

  const after = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(after.reserved, 0, "the real held reservation must be released back");

  const reservation = await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: order.id } });
  assert.equal(reservation.status, "RELEASED");
});

test("cancelling a PAID, unfulfilled order restocks real inventory and reverses real settlement via a REFUND entry", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, sellerId, variantId } = await makeSellerBuyerVariant(suffix);
  const { orderNumber, lineId } = await makePaidOrder(suffix, buyerId, sellerId, variantId);

  const balanceBefore = await getSellerBalance(sellerId);
  assert.equal(balanceBefore.payableSantim, 9_000);
  const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventoryBefore.onHand, 9);

  await cancelOrder(buyerId, orderNumber);

  const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber } });
  assert.equal(order.status, "CANCELLED");

  const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventoryAfter.onHand, 10, "the cancelled unit must be restocked");

  const balanceAfter = await getSellerBalance(sellerId);
  assert.equal(balanceAfter.payableSantim, 0, "the REFUND entry must cancel out the original net exactly");

  const refundEntry = await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { orderLineId: lineId, type: "REFUND" } });
  assert.equal(refundEntry.amountSantim, -9_000);
});

test("cancelling a PAID order that restocks a variant from zero enqueues a real back-in-stock check", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, sellerId, variantId } = await makeSellerBuyerVariant(suffix);
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 1 } }); // will go to zero once "paid"
  const { orderNumber } = await makePaidOrder(suffix, buyerId, sellerId, variantId);

  const waitingBuyer = await prisma.user.create({ data: { email: `cancel-waiting-${suffix}@example.et`, role: "CUSTOMER" } });
  await prisma.backInStockRequest.create({ data: { userId: waitingBuyer.id, variantId } });

  await cancelOrder(buyerId, orderNumber);

  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.onHand, 1, "back to the real original quantity");

  const forThisVariant = (await prisma.outboxMessage.findMany({ where: { topic: "variant.restocked" } })).filter(
    (m) => (m.payload as { variantId: string }).variantId === variantId,
  );
  assert.equal(forThisVariant.length, 1, "cancelling an order that restocks a variant from zero must enqueue a real back-in-stock check");
});

test("an order that's already partially shipped cannot be cancelled — the customer must use returns instead", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, sellerId, variantId } = await makeSellerBuyerVariant(suffix);
  const { orderNumber } = await makePaidOrder(suffix, buyerId, sellerId, variantId, "PARTIALLY_FULFILLED");

  await assert.rejects(
    () => cancelOrder(buyerId, orderNumber),
    (err: unknown) => err instanceof OrderCancellationError && /already started shipping/.test(err.message),
  );

  const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber } });
  assert.equal(order.status, "PAID", "a rejected cancellation must not have changed anything");
});

test("a stranger cannot cancel another customer's order — indistinguishable from not found", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, sellerId, variantId } = await makeSellerBuyerVariant(suffix);
  const { orderNumber } = await makePendingPaymentOrder(suffix, buyerId, sellerId, variantId);
  const stranger = await prisma.user.create({ data: { email: `cancel-stranger-${suffix}@example.et`, role: "CUSTOMER" } });

  await assert.rejects(
    () => cancelOrder(stranger.id, orderNumber),
    (err: unknown) => err instanceof OrderCancellationError && /not found/.test(err.message),
  );

  const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber } });
  assert.equal(order.status, "PENDING_PAYMENT", "a stranger's attempt must not have changed anything");
});

test("cancelling an order twice is rejected the second time — a real terminal state, not a silent no-op", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, sellerId, variantId } = await makeSellerBuyerVariant(suffix);
  const { orderNumber } = await makePendingPaymentOrder(suffix, buyerId, sellerId, variantId);

  await cancelOrder(buyerId, orderNumber);
  await assert.rejects(() => cancelOrder(buyerId, orderNumber), OrderCancellationError);
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "variant.restocked" } });
  await prisma.backInStockRequest.deleteMany({ where: { variant: { product: { slug: { startsWith: "cancel-test-product-" } } } } });
  await prisma.sellerLedgerEntry.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-CANCEL" } } } });
  await prisma.orderEvent.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-CANCEL" } } } });
  await prisma.inventoryReservation.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-CANCEL" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-CANCEL" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-CANCEL" } } });
  await prisma.inventory.deleteMany({ where: { variant: { product: { slug: { startsWith: "cancel-test-product-" } } } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "cancel-test-product-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "cancel-test-product-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "cancel-test-seller-" } } });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: "cancel-seller-" } },
        { email: { startsWith: "cancel-buyer-" } },
        { email: { startsWith: "cancel-stranger-" } },
        { email: { startsWith: "cancel-waiting-" } },
      ],
    },
  });
  await prisma.$disconnect();
});
