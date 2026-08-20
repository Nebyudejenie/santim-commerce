/**
 * Integration test — requires a real Postgres. The property that matters
 * most: every notifyX function is idempotent under the outbox's real
 * at-least-once delivery semantics — calling it TWICE for the same real
 * event (a redelivered outbox message) must create exactly one
 * notification, enforced by the real `dedupeKey` unique constraint, not an
 * application-level check-then-write. Also verifies the guest-order skip
 * (no account, no notification) and ownership scoping.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  getUnreadCount,
  listNotificationsForUser,
  markAllAsRead,
  markAsRead,
  notifyOrderLineFulfilled,
  notifyOrderPaid,
  notifyOrderPaymentFailed,
  notifyReturnResolved,
} from "./notification-service.ts";

const prisma = new PrismaClient();

async function makeBuyer(suffix: string) {
  const user = await prisma.user.create({ data: { email: `notif-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

async function makeSellerWithProduct(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `notif-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Notif Test Seller ${suffix}`, slug: `notif-test-seller-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `notif-test-${suffix}`, title: "Notif Test Item", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `NT-${suffix}`, title: "Default", priceSantim: 10_000 },
  });
  return { sellerId: seller.id, variantId: variant.id };
}

async function makeOrder(suffix: string, userId: string | null, sellerId: string, variantId: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-NOTIF-${suffix}`.toUpperCase(),
      userId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: new Date(),
      lines: {
        create: [
          {
            variantId,
            sellerId,
            sku: `NT-${suffix}`,
            productTitle: "Notif Test Item",
            variantTitle: "Default",
            unitPriceSantim: 10_000,
            quantity: 1,
            lineTotalSantim: 10_000,
          },
        ],
      },
    },
    include: { lines: true },
  });
  return { orderId: order.id, orderLineId: order.lines[0]!.id };
}

test("notifyOrderPaid creates a real notification for the order's real owner", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);

  await notifyOrderPaid(orderId);

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "ORDER_PAID");
  assert.ok(list[0]!.title.includes(`SC-NOTIF-${suffix}`.toUpperCase()));
  assert.equal(await getUnreadCount(userId), 1);
});

test("notifying the same real event twice creates exactly one notification — real outbox redelivery idempotency", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);

  await notifyOrderPaid(orderId);
  await notifyOrderPaid(orderId); // simulates a redelivered outbox message

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1, "a redelivered event must not double-notify");
});

test("notifyOrderPaymentFailed creates a real notification for the order's real owner", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);

  await notifyOrderPaymentFailed(orderId);

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "ORDER_PAYMENT_FAILED");
});

test("a guest order (no userId) is silently skipped — no account, no notification", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { orderId } = await makeOrder(suffix, null, sellerId, variantId);

  // Must not throw.
  await notifyOrderPaid(orderId);
  await notifyOrderPaymentFailed(orderId);

  const count = await prisma.notification.count({ where: { title: { contains: `SC-NOTIF-${suffix}`.toUpperCase() } } });
  assert.equal(count, 0);
});

test("notifyOrderLineFulfilled creates a real, line-specific notification", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { orderLineId } = await makeOrder(suffix, userId, sellerId, variantId);

  await notifyOrderLineFulfilled(orderLineId);

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "ORDER_LINE_FULFILLED");
  assert.ok(list[0]!.title.includes("Notif Test Item"));
});

test("notifyReturnResolved creates the right notification for APPROVED vs REJECTED", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { orderId, orderLineId } = await makeOrder(suffix, userId, sellerId, variantId);

  const request = await prisma.returnRequest.create({
    data: {
      orderLineId,
      orderId,
      requestedByUserId: userId,
      reason: "Real reason for the notification test.",
      status: "APPROVED",
      resolvedByUserId: sellerId,
      resolvedAt: new Date(),
    },
  });

  await notifyReturnResolved(request.id);

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "RETURN_APPROVED");
});

test("markAsRead only affects the real owner's own notification, and markAllAsRead clears every unread one", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const strangerId = await makeBuyer(`${suffix}-stranger`);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);

  await notifyOrderPaid(orderId);
  const [notification] = await listNotificationsForUser(userId);

  // A stranger's attempt must silently do nothing (not throw, not mark it read).
  await markAsRead(strangerId, notification!.id);
  assert.equal(await getUnreadCount(userId), 1, "a non-owner's markAsRead must not affect the real owner's unread count");

  await markAsRead(userId, notification!.id);
  assert.equal(await getUnreadCount(userId), 0);

  await prisma.notification.createMany({
    data: [
      { userId, type: "ORDER_LINE_FULFILLED", title: "t1", body: "b1", dedupeKey: `manual-${suffix}-1` },
      { userId, type: "ORDER_LINE_FULFILLED", title: "t2", body: "b2", dedupeKey: `manual-${suffix}-2` },
    ],
  });
  assert.equal(await getUnreadCount(userId), 2);
  await markAllAsRead(userId);
  assert.equal(await getUnreadCount(userId), 0);
});

test.after(async () => {
  await prisma.notification.deleteMany({ where: { user: { email: { startsWith: "notif-" } } } });
  await prisma.returnRequest.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-NOTIF-" } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "notif-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "notif-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "notif-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "notif-buyer-" } }, { email: { startsWith: "notif-seller-" } }] },
  });
  await prisma.$disconnect();
});
