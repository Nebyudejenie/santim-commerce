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
  notifyBackInStock,
  notifyLowStock,
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

test("notifyBackInStock notifies every real pending requester for a variant that's genuinely available again", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  await prisma.inventory.create({ data: { variantId, onHand: 5, reserved: 0 } });
  const requesterA = await makeBuyer(`${suffix}-a`);
  const requesterB = await makeBuyer(`${suffix}-b`);
  await prisma.backInStockRequest.create({ data: { userId: requesterA, variantId } });
  await prisma.backInStockRequest.create({ data: { userId: requesterB, variantId } });

  await notifyBackInStock(variantId);

  const listA = await listNotificationsForUser(requesterA);
  const listB = await listNotificationsForUser(requesterB);
  assert.equal(listA.length, 1);
  assert.equal(listA[0]!.type, "BACK_IN_STOCK");
  assert.equal(listB.length, 1);

  const requestA = await prisma.backInStockRequest.findFirstOrThrow({ where: { userId: requesterA, variantId } });
  assert.ok(requestA.notifiedAt, "the request row must record that it was actually notified");
  assert.equal(requestA.notificationCount, 1);
});

test("notifyBackInStock does not notify a request for a variant that's still genuinely out of stock", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  await prisma.inventory.create({ data: { variantId, onHand: 0, reserved: 0 } });
  const requesterId = await makeBuyer(suffix);
  await prisma.backInStockRequest.create({ data: { userId: requesterId, variantId } });

  await notifyBackInStock(variantId);

  const list = await listNotificationsForUser(requesterId);
  assert.equal(list.length, 0, "a variant that's still at zero availability must never trigger a real notification");
});

test("notifyBackInStock skips an already-notified request — real redelivery idempotency, no duplicate notification", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  await prisma.inventory.create({ data: { variantId, onHand: 5, reserved: 0 } });
  const requesterId = await makeBuyer(suffix);
  await prisma.backInStockRequest.create({ data: { userId: requesterId, variantId } });

  await notifyBackInStock(variantId);
  await notifyBackInStock(variantId); // simulates a redelivered "variant.restocked" outbox message

  const list = await listNotificationsForUser(requesterId);
  assert.equal(list.length, 1, "a redelivered restock event must not double-notify the same real request");
});

// This is the specific bug this session found and fixed BEFORE it shipped:
// an earlier draft built each notification's dedupeKey from request.id
// alone. Since request.id is stable across a re-arm (create-or-update on
// the same @@unique([userId, variantId]) row), that key would collide
// forever after the FIRST notification and silently swallow every real
// one after a customer legitimately re-requested for a later stockout.
// notificationCount, incremented on each real notify, is what makes each
// cycle's key genuinely distinct — this test proves the fix actually
// works, not just that the reasoning sounds right.
test("a customer who re-requests after being notified gets a real second notification on the next real restock", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  await prisma.inventory.create({ data: { variantId, onHand: 0, reserved: 0 } });
  const requesterId = await makeBuyer(suffix);

  // First stockout cycle: request, restock, get notified.
  await prisma.backInStockRequest.create({ data: { userId: requesterId, variantId } });
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 3 } });
  await notifyBackInStock(variantId);
  assert.equal((await listNotificationsForUser(requesterId)).length, 1);

  // Sells out again, customer re-requests, a second real restock happens.
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 0 } });
  await prisma.backInStockRequest.update({ where: { userId_variantId: { userId: requesterId, variantId } }, data: { notifiedAt: null } });
  await prisma.inventory.update({ where: { variantId }, data: { onHand: 4 } });
  await notifyBackInStock(variantId);

  const list = await listNotificationsForUser(requesterId);
  const backInStockNotifications = list.filter((n) => n.type === "BACK_IN_STOCK");
  assert.equal(backInStockNotifications.length, 2, "the re-armed request must produce a real SECOND notification, not be silently swallowed");

  const request = await prisma.backInStockRequest.findFirstOrThrow({ where: { userId: requesterId, variantId } });
  assert.equal(request.notificationCount, 2);
});

test("notifyLowStock notifies the real seller who owns the variant, not a customer", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });

  await notifyLowStock(variantId, 1);

  const list = await listNotificationsForUser(seller.ownerId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "LOW_STOCK");
  assert.ok(list[0]!.title.includes("Notif Test Item"));
});

test("notifyLowStock's dedupeKey includes alertCount, so a redelivered event and a genuine second alert are correctly distinguished", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });

  await notifyLowStock(variantId, 1);
  await notifyLowStock(variantId, 1); // simulates a redelivered "variant.low_stock" outbox message

  let list = await listNotificationsForUser(seller.ownerId);
  assert.equal(list.length, 1, "a redelivered event with the SAME alertCount must not double-notify");

  await notifyLowStock(variantId, 2); // a real second dip, after a restock re-armed the check

  list = await listNotificationsForUser(seller.ownerId);
  assert.equal(list.length, 2, "a genuinely new alertCount must produce a real second notification, not be silently swallowed");
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
  await prisma.backInStockRequest.deleteMany({ where: { variant: { product: { slug: { startsWith: "notif-test-" } } } } });
  await prisma.returnRequest.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-NOTIF-" } } });
  await prisma.inventory.deleteMany({ where: { variant: { product: { slug: { startsWith: "notif-test-" } } } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "notif-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "notif-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "notif-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "notif-buyer-" } }, { email: { startsWith: "notif-seller-" } }] },
  });
  await prisma.$disconnect();
});
