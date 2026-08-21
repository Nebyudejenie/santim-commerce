/**
 * Integration test — requires a real Postgres. First dedicated coverage
 * for this module. The properties that matter most: `search` matches
 * either the order number or a line's product title, and never leaks
 * another user's order regardless of what's searched for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { getOrdersForUser } from "./get-user-orders.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string): Promise<string> {
  const owner = await prisma.user.create({ data: { email: `gu-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `GU Seller ${suffix}`, slug: `gu-seller-${suffix}`, status: "APPROVED" },
  });
  return seller.id;
}

async function makeOrder(suffix: string, userId: string, orderNumber: string, productTitle: string) {
  const sellerId = await makeSeller(suffix);
  return prisma.order.create({
    data: {
      orderNumber,
      userId,
      email: `buyer-${suffix}@example.et`,
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 1000,
      totalSantim: 1000,
      paidAt: new Date(),
      lines: {
        create: [{ sellerId, sku: `GU-${suffix}`, productTitle, variantTitle: "Default", unitPriceSantim: 1000, quantity: 1, lineTotalSantim: 1000 }],
      },
    },
  });
}

test("search matches the order number or a line's product title, scoped to the calling user only", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({ data: { email: `gu-user-${suffix}@example.et`, role: "CUSTOMER" } });
  const stranger = await prisma.user.create({ data: { email: `gu-stranger-${suffix}@example.et`, role: "CUSTOMER" } });

  await makeOrder(`${suffix}-a`, user.id, `SC-GUTESTA${suffix}`.toUpperCase(), "Blue Jacket");
  await makeOrder(`${suffix}-b`, user.id, `SC-GUTESTB${suffix}`.toUpperCase(), "Red Shoes");
  await makeOrder(`${suffix}-s`, stranger.id, `SC-GUTESTS${suffix}`.toUpperCase(), "Blue Jacket");

  const byOrderNumber = await getOrdersForUser(user.id, `SC-GUTESTA${suffix}`.toUpperCase());
  assert.equal(byOrderNumber.length, 1);

  const byProductTitle = await getOrdersForUser(user.id, "Blue Jacket");
  assert.equal(byProductTitle.length, 1, "must find this user's own Blue Jacket order, not the stranger's");
  assert.equal(byProductTitle[0]!.lines[0]!.productTitle, "Blue Jacket");

  const strangerOrders = await getOrdersForUser(stranger.id, "Blue Jacket");
  assert.equal(strangerOrders.length, 1, "the stranger's own search must only ever find their own order");

  const noMatch = await getOrdersForUser(user.id, "no such product or order");
  assert.equal(noMatch.length, 0);

  const all = await getOrdersForUser(user.id);
  assert.equal(all.length, 2, "no search term must return every one of the user's own orders");
});

test.after(async () => {
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-GUTEST" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-GUTEST" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "gu-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "gu-user-" } }, { email: { startsWith: "gu-stranger-" } }, { email: { startsWith: "gu-seller-" } }] },
  });
  await prisma.$disconnect();
});
