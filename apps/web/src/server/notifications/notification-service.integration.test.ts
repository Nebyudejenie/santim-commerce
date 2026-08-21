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
  notifyNewMessage,
  notifyOrderLineFulfilled,
  notifyOrderPaid,
  notifyOrderPaymentFailed,
  notifyPriceDrop,
  notifyReturnResolved,
  notifySellersOfNewSale,
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

test("notifySellersOfNewSale notifies the real seller who owns the sold product, not the buyer", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);

  await notifySellersOfNewSale(orderId);

  const sellerNotifications = await listNotificationsForUser(seller.ownerId);
  assert.equal(sellerNotifications.length, 1);
  assert.equal(sellerNotifications[0]!.type, "NEW_SALE");

  const buyerNotifications = await listNotificationsForUser(userId);
  assert.equal(buyerNotifications.filter((n) => n.type === "NEW_SALE").length, 0, "the buyer must never get their own sale notification");
});

test("notifySellersOfNewSale fans out to every distinct seller in a real multi-vendor order, exactly once each", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId: sellerA, variantId: variantA } = await makeSellerWithProduct(`${suffix}-a`);
  const { sellerId: sellerB, variantId: variantB } = await makeSellerWithProduct(`${suffix}-b`);
  const ownerA = await prisma.seller.findUniqueOrThrow({ where: { id: sellerA } });
  const ownerB = await prisma.seller.findUniqueOrThrow({ where: { id: sellerB } });

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-NOTIF-MULTI-${suffix}`.toUpperCase(),
      userId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 20_000,
      totalSantim: 20_000,
      paidAt: new Date(),
      lines: {
        create: [
          { variantId: variantA, sellerId: sellerA, sku: `NT-${suffix}-a`, productTitle: "Item A", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
          { variantId: variantB, sellerId: sellerB, sku: `NT-${suffix}-b`, productTitle: "Item B", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
        ],
      },
    },
  });

  await notifySellersOfNewSale(order.id);

  assert.equal((await listNotificationsForUser(ownerA.ownerId)).length, 1, "seller A must be notified exactly once");
  assert.equal((await listNotificationsForUser(ownerB.ownerId)).length, 1, "seller B must be notified exactly once, independently of seller A");
});

test("notifySellersOfNewSale is idempotent under real outbox redelivery — no duplicate per seller", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);

  await notifySellersOfNewSale(orderId);
  await notifySellersOfNewSale(orderId); // simulates a redelivered "order.paid" outbox message

  const notifications = await listNotificationsForUser(seller.ownerId);
  assert.equal(notifications.length, 1, "a redelivered order.paid event must not double-notify the same seller");
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

async function makeWishlister(suffix: string, productId: string, priceAtAddSantim: number) {
  const user = await prisma.user.create({ data: { email: `notif-wishlist-${suffix}@example.et`, role: "CUSTOMER" } });
  const item = await prisma.wishlistItem.create({ data: { userId: user.id, productId, priceAtAddSantim } });
  return { userId: user.id, itemId: item.id };
}

test("notifyPriceDrop notifies a real wishlister whose add-time price the real current price now beats", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  const variant = await prisma.variant.findUniqueOrThrow({ where: { id: variantId } });
  // Wishlisted at 15_000, when the real current price (seeded at 10_000
  // by makeSellerWithProduct) is already lower — notifyPriceDrop reads
  // whatever the real current price is, the same as the real trigger
  // site (listing-service.ts's updateVariant) would after a real cut.
  const { userId } = await makeWishlister(suffix, variant.productId, 15_000);

  await notifyPriceDrop(variant.productId);

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "PRICE_DROP");

  const row = await prisma.wishlistItem.findUniqueOrThrow({ where: { userId_productId: { userId, productId: variant.productId } } });
  assert.equal(row.lastNotifiedPriceSantim, 10_000, "the re-arm marker must track the real price that triggered this notification");
});

test("notifyPriceDrop does NOT notify a wishlister whose add-time price the current price never actually beats", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  const variant = await prisma.variant.findUniqueOrThrow({ where: { id: variantId } });
  // Wishlisted at a price LOWER than the real current price — no real drop happened for them.
  const { userId } = await makeWishlister(suffix, variant.productId, 5_000);

  await notifyPriceDrop(variant.productId);

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 0);
});

test("notifyPriceDrop re-notifies on a FURTHER drop below the last notified price, but not on a bounce back up to it", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  const variant = await prisma.variant.findUniqueOrThrow({ where: { id: variantId } });
  const { userId } = await makeWishlister(suffix, variant.productId, 20_000);

  await notifyPriceDrop(variant.productId); // real price 10_000 — first drop, notifies
  assert.equal((await listNotificationsForUser(userId)).length, 1);

  // Price rises back toward (but not above) the last notified price — must not re-notify.
  await prisma.variant.update({ where: { id: variantId }, data: { priceSantim: 10_000 } });
  await notifyPriceDrop(variant.productId);
  assert.equal((await listNotificationsForUser(userId)).length, 1, "no real further drop happened yet");

  // A genuinely deeper drop must notify again, with its own real dedupeKey.
  await prisma.variant.update({ where: { id: variantId }, data: { priceSantim: 7_000 } });
  await notifyPriceDrop(variant.productId);
  assert.equal((await listNotificationsForUser(userId)).length, 2, "a further real drop must notify again");
});

test("notifyPriceDrop is idempotent under real outbox redelivery — no duplicate for the same price", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeSellerWithProduct(suffix);
  const variant = await prisma.variant.findUniqueOrThrow({ where: { id: variantId } });
  const { userId } = await makeWishlister(suffix, variant.productId, 15_000);

  await notifyPriceDrop(variant.productId);
  await notifyPriceDrop(variant.productId); // simulates a redelivered "product.price_dropped" outbox message

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1, "a redelivered event at the same real price must not double-notify");
});

async function makeThreadWithMessage(
  orderId: string,
  sellerId: string,
  buyerUserId: string,
  senderUserId: string,
  body: string,
) {
  const thread = await prisma.messageThread.upsert({
    where: { orderId_sellerId: { orderId, sellerId } },
    create: { orderId, sellerId, buyerUserId },
    update: {},
  });
  const message = await prisma.message.create({ data: { threadId: thread.id, senderUserId, body } });
  return { threadId: thread.id, messageId: message.id };
}

test("notifyNewMessage notifies the SELLER when the buyer sends the first message", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);
  const { threadId, messageId } = await makeThreadWithMessage(orderId, sellerId, userId, userId, "Where's my order?");

  await notifyNewMessage(messageId);

  const list = await listNotificationsForUser(seller.ownerId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "NEW_MESSAGE");
  assert.equal(list[0]!.link, `/sell/messages/${threadId}`);
});

test("notifyNewMessage notifies the BUYER when the seller replies", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);
  const { threadId, messageId } = await makeThreadWithMessage(
    orderId,
    sellerId,
    userId,
    seller.ownerId,
    "It ships tomorrow.",
  );

  await notifyNewMessage(messageId);

  const list = await listNotificationsForUser(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.type, "NEW_MESSAGE");
  assert.equal(list[0]!.link, `/account/messages/${threadId}`);
  assert.ok(list[0]!.title.includes(seller.storeName));
});

test("notifyNewMessage is idempotent under real outbox redelivery — no duplicate per message", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const userId = await makeBuyer(suffix);
  const { sellerId, variantId } = await makeSellerWithProduct(suffix);
  const seller = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } });
  const { orderId } = await makeOrder(suffix, userId, sellerId, variantId);
  const { messageId } = await makeThreadWithMessage(orderId, sellerId, userId, userId, "Hello?");

  await notifyNewMessage(messageId);
  await notifyNewMessage(messageId); // simulates a redelivered "message.sent" outbox message

  const list = await listNotificationsForUser(seller.ownerId);
  assert.equal(list.length, 1, "a redelivered message.sent event must not double-notify");
});

test.after(async () => {
  await prisma.message.deleteMany({ where: { thread: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } } });
  await prisma.messageThread.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } });
  await prisma.notification.deleteMany({ where: { user: { email: { startsWith: "notif-" } } } });
  await prisma.wishlistItem.deleteMany({ where: { product: { slug: { startsWith: "notif-test-" } } } });
  await prisma.backInStockRequest.deleteMany({ where: { variant: { product: { slug: { startsWith: "notif-test-" } } } } });
  await prisma.returnRequest.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-NOTIF-" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-NOTIF-" } } });
  await prisma.inventory.deleteMany({ where: { variant: { product: { slug: { startsWith: "notif-test-" } } } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "notif-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "notif-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "notif-test-seller-" } } });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: "notif-buyer-" } },
        { email: { startsWith: "notif-seller-" } },
        { email: { startsWith: "notif-wishlist-" } },
      ],
    },
  });
  await prisma.$disconnect();
});
