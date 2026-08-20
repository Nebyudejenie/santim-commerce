/**
 * Integration test — requires a real Postgres. Builds a real seller with a
 * deliberately mixed order/return/review history so every rate metric has
 * a real, hand-computable expected value — not just "the query didn't
 * crash." Also covers the zero-data seller: every rate must come back
 * `null`, never `NaN` or a divide-by-zero crash.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { getSellerReputation } from "./seller-reputation-service.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `rep-test-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Reputation Test ${suffix}`, slug: `rep-test-${suffix}`, status: "APPROVED" },
  });
  const buyer = await prisma.user.create({ data: { email: `rep-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `rep-test-${suffix}`, title: "Reputation Test Item", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `REP-${suffix}`, title: "Default", priceSantim: 10_000 },
  });
  await prisma.inventory.create({ data: { variantId: variant.id, onHand: 20, reserved: 0 } });
  return { sellerId: seller.id, buyerId: buyer.id, productId: product.id, variantId: variant.id };
}

async function makeOrderLine(
  orderSuffix: string,
  sellerId: string,
  variantId: string,
  buyerId: string,
  opts: {
    orderStatus: "PENDING_PAYMENT" | "PAID" | "CANCELLED";
    fulfilmentStatus?: "UNFULFILLED" | "FULFILLED" | "RETURNED";
    paidAt?: Date;
    fulfilledAt?: Date;
  },
) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-REP-${orderSuffix}`.toUpperCase(),
      userId: buyerId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: opts.orderStatus,
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: opts.paidAt,
      lines: {
        create: [
          {
            variantId,
            sellerId,
            sku: `REP-${orderSuffix}`,
            productTitle: "Reputation Test Item",
            variantTitle: "Default",
            unitPriceSantim: 10_000,
            quantity: 1,
            lineTotalSantim: 10_000,
            fulfilmentStatus: opts.fulfilmentStatus ?? "UNFULFILLED",
            fulfilledAt: opts.fulfilledAt,
          },
        ],
      },
    },
    include: { lines: true },
  });
  return order.lines[0]!.id;
}

test("a seller with no history gets null rates, never NaN or a crash", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId } = await makeSeller(suffix);

  const rep = await getSellerReputation(sellerId);
  assert.equal(rep.totalOrderLines, 0);
  assert.equal(rep.completionRate, null);
  assert.equal(rep.cancellationRate, null);
  assert.equal(rep.returnRate, null);
  assert.equal(rep.lateShipmentRate, null);
  assert.equal(rep.disputeRate, null);
  assert.equal(rep.avgReviewResponseHours, null);
  assert.equal(rep.averageRating, null);
  assert.equal(rep.reviewCount, 0);
});

test("completion, cancellation, and return rates compute correctly from a mixed real history", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId, buyerId } = await makeSeller(suffix);
  const paidAt = new Date();

  // 2 settled+fulfilled, 1 settled+returned, 1 settled+still-unfulfilled, 1 cancelled, 1 still-pending-payment.
  await makeOrderLine(`${suffix}-1`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "FULFILLED", paidAt, fulfilledAt: paidAt });
  await makeOrderLine(`${suffix}-2`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "FULFILLED", paidAt, fulfilledAt: paidAt });
  await makeOrderLine(`${suffix}-3`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "RETURNED", paidAt, fulfilledAt: paidAt });
  await makeOrderLine(`${suffix}-4`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "UNFULFILLED", paidAt });
  await makeOrderLine(`${suffix}-5`, sellerId, variantId, buyerId, { orderStatus: "CANCELLED" });
  await makeOrderLine(`${suffix}-6`, sellerId, variantId, buyerId, { orderStatus: "PENDING_PAYMENT" });

  const rep = await getSellerReputation(sellerId);
  assert.equal(rep.totalOrderLines, 6);
  assert.equal(rep.settledOrderLines, 4, "only PAID/REFUNDED/PARTIALLY_REFUNDED lines count as settled");
  assert.equal(rep.completionRate, 3 / 4, "3 of 4 settled lines reached FULFILLED or RETURNED");
  assert.equal(rep.cancellationRate, 1 / 6, "1 of all 6 lines belonged to a CANCELLED order");
  assert.equal(rep.returnRate, 1 / 3, "1 of the 3 fulfilled-or-returned lines was RETURNED");
});

test("late shipment rate correctly flags a line fulfilled past the default SLA", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId, buyerId } = await makeSeller(suffix);
  const paidAt = new Date("2026-01-01T00:00:00Z");
  const onTime = new Date("2026-01-01T10:00:00Z"); // 10h later
  const late = new Date("2026-01-05T00:00:00Z"); // 96h later

  await makeOrderLine(`${suffix}-1`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "FULFILLED", paidAt, fulfilledAt: onTime });
  await makeOrderLine(`${suffix}-2`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "FULFILLED", paidAt, fulfilledAt: late });

  const rep = await getSellerReputation(sellerId);
  assert.equal(rep.lateShipmentRate, 0.5, "exactly one of the two fulfilled lines exceeded the 48h default SLA");
});

test("dispute rate distinguishes a seller-resolved return from an admin-escalated one", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId, buyerId } = await makeSeller(suffix);
  const admin = await prisma.user.create({ data: { email: `rep-admin-${suffix}@example.et`, role: "ADMIN" } });

  const line1 = await makeOrderLine(`${suffix}-1`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "FULFILLED", paidAt: new Date(), fulfilledAt: new Date() });
  const line2 = await makeOrderLine(`${suffix}-2`, sellerId, variantId, buyerId, { orderStatus: "PAID", fulfilmentStatus: "FULFILLED", paidAt: new Date(), fulfilledAt: new Date() });

  const order1 = await prisma.orderLine.findUniqueOrThrow({ where: { id: line1 }, select: { orderId: true } });
  const order2 = await prisma.orderLine.findUniqueOrThrow({ where: { id: line2 }, select: { orderId: true } });

  // Seller resolves their own return (resolvedByUserId = the seller's own id — see return-service.ts).
  await prisma.returnRequest.create({
    data: {
      orderLineId: line1,
      orderId: order1.orderId,
      requestedByUserId: buyerId,
      reason: "Real reason for a seller-resolved return.",
      status: "REJECTED",
      resolvedByUserId: sellerId,
      resolvedAt: new Date(),
    },
  });
  // Admin escalation (resolvedByUserId = a real admin User.id).
  await prisma.returnRequest.create({
    data: {
      orderLineId: line2,
      orderId: order2.orderId,
      requestedByUserId: buyerId,
      reason: "Real reason for an admin-escalated return.",
      status: "APPROVED",
      resolvedByUserId: admin.id,
      resolvedAt: new Date(),
    },
  });

  const rep = await getSellerReputation(sellerId);
  assert.equal(rep.disputeRate, 0.5, "exactly one of the two resolved returns needed admin escalation");
});

test("average review response time is computed correctly from real responded reviews", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, productId, variantId, buyerId } = await makeSeller(suffix);
  const orderLineId = await makeOrderLine(`${suffix}-1`, sellerId, variantId, buyerId, { orderStatus: "PAID" });
  const { orderId } = await prisma.orderLine.findUniqueOrThrow({ where: { id: orderLineId }, select: { orderId: true } });

  const createdAt = new Date("2026-01-01T00:00:00Z");
  const respondedAt = new Date("2026-01-03T00:00:00Z"); // 48h later

  await prisma.productReview.create({
    data: {
      productId,
      userId: buyerId,
      orderId,
      rating: 5,
      title: "Great",
      body: "Real review body for the reputation test.",
      createdAt,
      sellerRespondedAt: respondedAt,
      sellerResponse: "Thanks!",
    },
  });

  const rep = await getSellerReputation(sellerId);
  assert.equal(rep.avgReviewResponseHours, 48);
});

test.after(async () => {
  await prisma.productReview.deleteMany({ where: { product: { slug: { startsWith: "rep-test-" } } } });
  await prisma.returnRequest.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-REP-" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-REP-" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-REP-" } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "rep-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "rep-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "rep-test-" } } });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: "rep-test-" } },
        { email: { startsWith: "rep-buyer-" } },
        { email: { startsWith: "rep-admin-" } },
      ],
    },
  });
  await prisma.$disconnect();
});
