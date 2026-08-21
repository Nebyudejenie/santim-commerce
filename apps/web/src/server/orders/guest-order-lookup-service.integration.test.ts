/**
 * Integration test — requires a real Postgres. The property that matters
 * most: order number + email is a real credential pair, not a decoration —
 * a matching order number with the WRONG email must fail exactly like a
 * nonexistent order number, never leaking which half was wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { getOrderForGuestLookup } from "./guest-order-lookup-service.ts";

const prisma = new PrismaClient();

async function makeOrder(suffix: string, email: string) {
  const sellerOwner = await prisma.user.create({ data: { email: `guest-lookup-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: sellerOwner.id, storeName: `Guest Lookup Seller ${suffix}`, slug: `guest-lookup-seller-${suffix}`, status: "APPROVED", commissionBps: 1000 },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `guest-lookup-product-${suffix}`, title: "Guest Lookup Product", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({ data: { productId: product.id, sku: `GL-${suffix}`, title: "Default", priceSantim: 5_000 } });

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-GUEST${suffix}`.toUpperCase(),
      email,
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 5_000,
      totalSantim: 5_000,
      paidAt: new Date(),
      lines: {
        create: [
          { variantId: variant.id, sellerId: seller.id, sku: `GL-${suffix}`, productTitle: "Guest Lookup Product", variantTitle: "Default", unitPriceSantim: 5_000, quantity: 1, lineTotalSantim: 5_000 },
        ],
      },
    },
  });
  return order.orderNumber;
}

test("a matching order number and email returns the order", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `guest-buyer-${suffix}@example.et`;
  const orderNumber = await makeOrder(suffix, email);

  const found = await getOrderForGuestLookup(orderNumber, email);
  assert.ok(found);
  assert.equal(found.orderNumber, orderNumber);
});

test("the email is matched case-insensitively and whitespace-tolerantly", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `guest-buyer-${suffix}@example.et`;
  const orderNumber = await makeOrder(suffix, email);

  const found = await getOrderForGuestLookup(`  ${orderNumber.toLowerCase()}  `, `  ${email.toUpperCase()}  `);
  assert.ok(found, "order number and email must both tolerate case/whitespace differences");
});

test("a real order number with the wrong email returns null", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `guest-buyer-${suffix}@example.et`;
  const orderNumber = await makeOrder(suffix, email);

  const found = await getOrderForGuestLookup(orderNumber, `not-${email}`);
  assert.equal(found, null);
});

test("a nonexistent order number returns null", async () => {
  const found = await getOrderForGuestLookup("SC-DOESNOTEXIST", "nobody@example.et");
  assert.equal(found, null);
});

test("empty order number or email returns null without querying", async () => {
  assert.equal(await getOrderForGuestLookup("", "someone@example.et"), null);
  assert.equal(await getOrderForGuestLookup("SC-WHATEVER", ""), null);
});

test.after(async () => {
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-GUEST" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-GUEST" } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "guest-lookup-product-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "guest-lookup-product-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "guest-lookup-seller-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "guest-lookup-seller-" } } });
  await prisma.$disconnect();
});
