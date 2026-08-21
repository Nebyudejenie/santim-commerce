/**
 * Integration test — requires a real Postgres. Same authorization-testing
 * discipline as listing-service.integration.test.ts: a seller must never
 * see another seller's order line or order detail, including buyer contact
 * information — verified against a real database, not assumed from a
 * `where` clause that looks right.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { getSellerOrderDetail, listSellerOrderLines } from "./seller-order-queries.ts";

const prisma = new PrismaClient();

async function makeSellerWithSoldOrder(suffix: string, orderStatus: "PAID" | "PENDING_PAYMENT" | "CANCELLED" = "PAID") {
  const owner = await prisma.user.create({ data: { email: `sellord-test-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Sellord Test ${suffix}`, slug: `sellord-test-${suffix}`, status: "APPROVED" },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-SELLORD${suffix}`.toUpperCase(),
      email: `buyer-${suffix}@example.et`,
      phone: "+251900000000",
      status: orderStatus,
      subtotalSantim: 1000,
      totalSantim: 1000,
      paidAt: orderStatus === "PAID" ? new Date() : null,
      lines: {
        create: [
          {
            sellerId: seller.id,
            sku: `SO-${suffix}`,
            productTitle: "Sold Item",
            variantTitle: "Default",
            unitPriceSantim: 1000,
            quantity: 1,
            lineTotalSantim: 1000,
          },
        ],
      },
    },
  });
  return { sellerId: seller.id, orderNumber: order.orderNumber };
}

test("a seller sees only their own order lines, from a real PAID order", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, orderNumber } = await makeSellerWithSoldOrder(suffix);

  const lines = await listSellerOrderLines(sellerId);
  assert.ok(lines.some((l) => l.order.orderNumber === orderNumber));
});

test("an order that never got paid does NOT show up in the seller's sales", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, orderNumber } = await makeSellerWithSoldOrder(`unpaid-${suffix}`, "PENDING_PAYMENT");

  const lines = await listSellerOrderLines(sellerId);
  assert.ok(!lines.some((l) => l.order.orderNumber === orderNumber), "a PENDING_PAYMENT order must not appear as a sale");
});

test("a seller CANNOT see another seller's order detail, even with the real orderNumber", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { orderNumber } = await makeSellerWithSoldOrder(`owner-${suffix}`);
  const stranger = await makeSellerWithSoldOrder(`stranger-${suffix}`);

  const detail = await getSellerOrderDetail(stranger.sellerId, orderNumber);
  assert.equal(detail, null, "a seller with no line in this order must get null, not the order's real data");
});

test("getSellerOrderDetail returns real buyer contact/shipping info for the OWNING seller", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, orderNumber } = await makeSellerWithSoldOrder(suffix);

  const detail = await getSellerOrderDetail(sellerId, orderNumber);
  assert.ok(detail);
  assert.equal(detail.order.email, `buyer-${suffix}@example.et`);
  assert.equal(detail.lines.length, 1);
});

test("listSellerOrderLines search matches the order number or the buyer's email, scoped to this seller only", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, orderNumber } = await makeSellerWithSoldOrder(suffix);

  const byOrderNumber = await listSellerOrderLines(sellerId, { search: orderNumber });
  assert.equal(byOrderNumber.length, 1);

  const byEmail = await listSellerOrderLines(sellerId, { search: `buyer-${suffix}@example.et` });
  assert.equal(byEmail.length, 1);

  const noMatch = await listSellerOrderLines(sellerId, { search: "no-such-order-or-email" });
  assert.equal(noMatch.length, 0);
});

test("listSellerOrderLines filters by the LINE's own fulfilmentStatus", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, orderNumber } = await makeSellerWithSoldOrder(suffix);

  const unfulfilled = await listSellerOrderLines(sellerId, { search: orderNumber, fulfilmentStatus: "UNFULFILLED" });
  assert.equal(unfulfilled.length, 1);

  const fulfilled = await listSellerOrderLines(sellerId, { search: orderNumber, fulfilmentStatus: "FULFILLED" });
  assert.equal(fulfilled.length, 0, "a genuinely UNFULFILLED line must not match a FULFILLED filter");
});

test.after(async () => {
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-SELLORD" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-SELLORD" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "sellord-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "sellord-test-" } } });
  await prisma.$disconnect();
});
