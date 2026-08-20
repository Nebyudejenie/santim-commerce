/**
 * Integration test — requires a real Postgres. Three properties matter
 * most here, all verified against real state, not mocked:
 *
 *  1. A return can only be requested for a FULFILLED line, and only by
 *     the order's actual owner.
 *  2. Approving a return does all three real things together — restocks
 *     inventory, moves the line to RETURNED, and reverses the seller's
 *     settlement via a real ledger entry — and a seller can never approve
 *     a return on another seller's line, even with the real request id.
 *  3. The ledger reversal actually cancels out the original SALE +
 *     COMMISSION net, not an arbitrary guessed amount.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  approveReturnAsAdmin,
  approveReturnAsSeller,
  rejectReturnAsSeller,
  requestReturn,
  ReturnError,
} from "./return-service.ts";
import { createLedgerEntriesForOrder, getSellerBalance } from "./settlement-service.ts";

const prisma = new PrismaClient();

async function makeSellerBuyerOrderLine(suffix: string, fulfilmentStatus: "FULFILLED" | "UNFULFILLED" = "FULFILLED") {
  const sellerOwner = await prisma.user.create({ data: { email: `return-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: sellerOwner.id, storeName: `Return Test Seller ${suffix}`, slug: `return-test-seller-${suffix}`, status: "APPROVED", commissionBps: 1000 },
  });
  const buyer = await prisma.user.create({ data: { email: `return-buyer-${suffix}@example.et`, role: "CUSTOMER" } });

  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `return-test-product-${suffix}`, title: "Return Test Product", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({ data: { productId: product.id, sku: `RT-${suffix}`, title: "Default", priceSantim: 10_000 } });
  await prisma.inventory.create({ data: { variantId: variant.id, onHand: 5, reserved: 0 } });

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-RETURN${suffix}`.toUpperCase(),
      userId: buyer.id,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: new Date(),
      lines: {
        create: [
          {
            variantId: variant.id,
            sellerId: seller.id,
            sku: `RT-${suffix}`,
            productTitle: "Return Test Product",
            variantTitle: "Default",
            unitPriceSantim: 10_000,
            quantity: 1,
            lineTotalSantim: 10_000,
            fulfilmentStatus,
            fulfilledAt: fulfilmentStatus === "FULFILLED" ? new Date() : null,
          },
        ],
      },
    },
    include: { lines: true },
  });

  return { sellerId: seller.id, buyerId: buyer.id, orderId: order.id, lineId: order.lines[0]!.id, variantId: variant.id };
}

test("a return cannot be requested for a line that hasn't shipped yet", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, lineId } = await makeSellerBuyerOrderLine(suffix, "UNFULFILLED");

  await assert.rejects(
    () => requestReturn(buyerId, lineId, "Changed my mind, real reason text."),
    (err: unknown) => err instanceof ReturnError && /actually been shipped/.test(err.message),
  );
});

test("only the order's real owner can request a return, not a stranger", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { lineId } = await makeSellerBuyerOrderLine(suffix);
  const stranger = await prisma.user.create({ data: { email: `return-stranger-${suffix}@example.et`, role: "CUSTOMER" } });

  await assert.rejects(() => requestReturn(stranger.id, lineId, "Not my order, real reason text."), ReturnError);
});

test("requesting a return twice for the same line is rejected", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, lineId } = await makeSellerBuyerOrderLine(suffix);

  await requestReturn(buyerId, lineId, "Doesn't fit, real reason text.");
  await assert.rejects(
    () => requestReturn(buyerId, lineId, "Trying again, real reason text."),
    (err: unknown) => err instanceof ReturnError && /already been requested/.test(err.message),
  );

  const count = await prisma.returnRequest.count({ where: { orderLineId: lineId } });
  assert.equal(count, 1);
});

test("approving a return restocks inventory, moves the line to RETURNED, and reverses settlement — the whole point of this feature", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, buyerId, orderId, lineId, variantId } = await makeSellerBuyerOrderLine(suffix);

  await createLedgerEntriesForOrder(orderId); // the sale actually settled first, same as production
  const balanceBeforeReturn = await getSellerBalance(sellerId);
  assert.equal(balanceBeforeReturn.payableSantim, 9_000); // 10000 - 10% commission

  const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventoryBefore.onHand, 5);

  await requestReturn(buyerId, lineId, "Item arrived damaged, real reason text.");
  const request = await prisma.returnRequest.findUniqueOrThrow({ where: { orderLineId: lineId } });

  await approveReturnAsSeller(sellerId, request.id, "Confirmed damaged, approved.");

  const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(line.fulfilmentStatus, "RETURNED");

  const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventoryAfter.onHand, 6, "the returned unit must be restocked");

  const balanceAfterReturn = await getSellerBalance(sellerId);
  assert.equal(balanceAfterReturn.payableSantim, 0, "the REFUND entry must cancel out the original net payable exactly");

  const refundEntry = await prisma.sellerLedgerEntry.findFirstOrThrow({ where: { orderLineId: lineId, type: "REFUND" } });
  assert.equal(refundEntry.amountSantim, -9_000);

  const outboxMessages = await prisma.outboxMessage.findMany({ where: { topic: "return.resolved" } });
  const forThisRequest = outboxMessages.filter((m) => (m.payload as { returnRequestId: string }).returnRequestId === request.id);
  assert.equal(forThisRequest.length, 1, "approving a return must enqueue exactly one return.resolved message");
});

test("a seller CANNOT approve a return on another seller's line, even with the real request id", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, lineId } = await makeSellerBuyerOrderLine(suffix);
  const { sellerId: strangerSellerId } = await makeSellerBuyerOrderLine(`stranger-${suffix}`);

  await requestReturn(buyerId, lineId, "Real reason for the return request.");
  const request = await prisma.returnRequest.findUniqueOrThrow({ where: { orderLineId: lineId } });

  await assert.rejects(() => approveReturnAsSeller(strangerSellerId, request.id), ReturnError);

  const untouched = await prisma.returnRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(untouched.status, "REQUESTED", "the cross-seller attempt must not have changed anything");
});

test("rejecting a return leaves inventory and the order line untouched", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, buyerId, lineId, variantId } = await makeSellerBuyerOrderLine(suffix);

  await requestReturn(buyerId, lineId, "Real reason for a return that gets rejected.");
  const request = await prisma.returnRequest.findUniqueOrThrow({ where: { orderLineId: lineId } });

  await rejectReturnAsSeller(sellerId, request.id, "No evidence of damage.");

  const rejected = await prisma.returnRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(rejected.status, "REJECTED");

  const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(line.fulfilmentStatus, "FULFILLED", "a rejected return must not change the fulfilment status");

  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.onHand, 5, "a rejected return must not restock anything");

  const outboxMessages = await prisma.outboxMessage.findMany({ where: { topic: "return.resolved" } });
  const forThisRequest = outboxMessages.filter((m) => (m.payload as { returnRequestId: string }).returnRequestId === request.id);
  assert.equal(forThisRequest.length, 1, "rejecting a return must also enqueue a real return.resolved message — the customer still needs to be told");
});

test("an admin can approve a return regardless of which seller owns the line", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { buyerId, lineId } = await makeSellerBuyerOrderLine(suffix);
  const admin = await prisma.user.create({ data: { email: `return-admin-${suffix}@example.et`, role: "ADMIN" } });

  await requestReturn(buyerId, lineId, "Escalated to admin, real reason text.");
  const request = await prisma.returnRequest.findUniqueOrThrow({ where: { orderLineId: lineId } });

  await approveReturnAsAdmin(admin.id, request.id, "Admin override approval.");

  const approved = await prisma.returnRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.resolvedByUserId, admin.id);
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "return.resolved" } });
  await prisma.returnRequest.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-RETURN" } } } });
  await prisma.sellerLedgerEntry.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-RETURN" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-RETURN" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-RETURN" } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "return-test-product-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "return-test-product-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "return-test-seller-" } } });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: "return-seller-" } },
        { email: { startsWith: "return-buyer-" } },
        { email: { startsWith: "return-stranger-" } },
        { email: { startsWith: "return-admin-" } },
      ],
    },
  });
  await prisma.$disconnect();
});
