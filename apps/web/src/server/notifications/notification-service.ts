/**
 * In-app customer notifications — populated by the outbox worker (see
 * worker/index.ts's deliver(), and its module comment on why side effects
 * never happen inside the transaction that made the underlying state
 * change real). No real email/SMS provider credentials exist in this
 * environment; this is the honest, buildable version of "notify the
 * customer" rather than a fabricated integration — see
 * docs/PROJECT-EXECUTION-STATE.md.
 *
 * Every `notifyX` function below is idempotent under the outbox's real
 * at-least-once delivery semantics via `dedupeKey`'s unique constraint —
 * a redelivered message hits P2002 and is treated as a no-op success, the
 * exact same pattern settlement-service.ts's ledger entries and
 * return-service.ts's REFUND entries already use.
 *
 * A guest order (Order.userId === null) has no account to notify — these
 * functions silently skip rather than throw, since "no notification
 * inbox exists for this order" is an expected, common case, not an error.
 */

import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

async function createOnce(input: {
  userId: string;
  type:
    | "ORDER_PAID"
    | "ORDER_PAYMENT_FAILED"
    | "ORDER_LINE_FULFILLED"
    | "RETURN_APPROVED"
    | "RETURN_REJECTED"
    | "QUESTION_ANSWERED"
    | "LOW_STOCK"
    | "NEW_SALE";
  title: string;
  body: string;
  link?: string;
  dedupeKey: string;
}): Promise<void> {
  try {
    await prisma.notification.create({ data: input });
  } catch (error) {
    if (isUniqueViolation(error)) {
      logger.info("notification.already_delivered", { dedupeKey: input.dedupeKey });
      return;
    }
    throw error;
  }
}

export async function notifyOrderPaid(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true, orderNumber: true } });
  if (!order || !order.userId) return;

  await createOnce({
    userId: order.userId,
    type: "ORDER_PAID",
    title: `Order ${order.orderNumber} confirmed`,
    body: `Your payment for order ${order.orderNumber} was confirmed. We'll notify you again once it ships.`,
    link: `/account/orders/${order.orderNumber}`,
    dedupeKey: `order-paid:${orderId}`,
  });
}

export async function notifyOrderPaymentFailed(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { userId: true, orderNumber: true } });
  if (!order || !order.userId) return;

  await createOnce({
    userId: order.userId,
    type: "ORDER_PAYMENT_FAILED",
    title: `Payment failed for order ${order.orderNumber}`,
    body: `We couldn't confirm your payment for order ${order.orderNumber}. Please try again from your order history.`,
    link: `/account/orders/${order.orderNumber}`,
    dedupeKey: `order-payment-failed:${orderId}`,
  });
}

export async function notifyOrderLineFulfilled(orderLineId: string): Promise<void> {
  const line = await prisma.orderLine.findUnique({
    where: { id: orderLineId },
    select: { productTitle: true, order: { select: { userId: true, orderNumber: true } } },
  });
  if (!line || !line.order.userId) return;

  await createOnce({
    userId: line.order.userId,
    type: "ORDER_LINE_FULFILLED",
    title: `${line.productTitle} has shipped`,
    body: `"${line.productTitle}" from order ${line.order.orderNumber} is on its way.`,
    link: `/account/orders/${line.order.orderNumber}`,
    dedupeKey: `order-line-fulfilled:${orderLineId}`,
  });
}

export async function notifyReturnResolved(returnRequestId: string): Promise<void> {
  const request = await prisma.returnRequest.findUnique({
    where: { id: returnRequestId },
    select: {
      status: true,
      requestedByUserId: true,
      orderLine: { select: { productTitle: true } },
      order: { select: { orderNumber: true } },
    },
  });
  if (!request || (request.status !== "APPROVED" && request.status !== "REJECTED")) return;

  const approved = request.status === "APPROVED";
  await createOnce({
    userId: request.requestedByUserId,
    type: approved ? "RETURN_APPROVED" : "RETURN_REJECTED",
    title: approved ? "Return approved" : "Return declined",
    body: approved
      ? `Your return for "${request.orderLine.productTitle}" (order ${request.order.orderNumber}) was approved.`
      : `Your return for "${request.orderLine.productTitle}" (order ${request.order.orderNumber}) was declined.`,
    link: `/account/orders/${request.order.orderNumber}`,
    dedupeKey: `return-resolved:${returnRequestId}`,
  });
}

export async function notifyQuestionAnswered(questionId: string): Promise<void> {
  const question = await prisma.productQuestion.findUnique({
    where: { id: questionId },
    select: { askedByUserId: true, product: { select: { slug: true, title: true } } },
  });
  if (!question) return;

  await createOnce({
    userId: question.askedByUserId,
    type: "QUESTION_ANSWERED",
    title: `Your question about ${question.product.title} was answered`,
    body: `The seller replied to your question about "${question.product.title}".`,
    link: `/products/${question.product.slug}#questions`,
    dedupeKey: `question-answered:${questionId}`,
  });
}

/**
 * Notifies every real customer with a real, still-pending
 * BackInStockRequest for this variant. Not built on `createOnce`: unlike
 * every other notifyX above (one recipient, one dedupeKey), this fans out
 * to potentially many recipients, and each one's dedupeKey has to be
 * derived from a per-recipient counter that's only known AFTER that
 * recipient's own row is updated — see BackInStockRequest's own comment
 * on why `notificationCount`, not `id` alone, has to be part of the key.
 */
export async function notifyBackInStock(variantId: string): Promise<void> {
  const variant = await prisma.variant.findUnique({
    where: { id: variantId },
    include: {
      inventory: true,
      product: { select: { title: true, slug: true } },
    },
  });
  if (!variant || !variant.inventory || variant.inventory.onHand - variant.inventory.reserved <= 0) return;

  const pending = await prisma.backInStockRequest.findMany({
    where: { variantId, notifiedAt: null },
    select: { id: true, userId: true },
  });

  for (const request of pending) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.backInStockRequest.update({
        where: { id: request.id },
        data: { notifiedAt: new Date(), notificationCount: { increment: 1 } },
      });
      try {
        await tx.notification.create({
          data: {
            userId: request.userId,
            type: "BACK_IN_STOCK",
            title: `${variant.product.title} is back in stock`,
            body: `"${variant.product.title}" (${variant.title}) is available again.`,
            link: `/products/${variant.product.slug}`,
            dedupeKey: `back-in-stock:${request.id}:${updated.notificationCount}`,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Already notified this exact cycle — a redelivered outbox message, not a bug.
      }
    });
  }
}

/**
 * The first SELLER-facing notification in this module — every notifyX
 * above targets a customer's userId. A seller's own Inventory has no
 * per-recipient request row to fan out to (they don't opt in to hearing
 * about their own stock), so this is a single-recipient `createOnce` call
 * like ORDER_PAID etc., not the fan-out `notifyBackInStock` needs.
 * `alertCount` comes from low-stock-service.ts's own atomic increment —
 * baking it into the dedupeKey is what lets a later real dip (after a
 * restock re-armed the check) produce a genuinely new key rather than
 * colliding with an earlier cycle's already-delivered notification.
 */
export async function notifyLowStock(variantId: string, alertCount: number): Promise<void> {
  const variant = await prisma.variant.findUnique({
    where: { id: variantId },
    select: {
      title: true,
      productId: true,
      product: { select: { title: true, seller: { select: { ownerId: true } } } },
    },
  });
  if (!variant) return;

  await createOnce({
    userId: variant.product.seller.ownerId,
    type: "LOW_STOCK",
    title: `${variant.product.title} is running low`,
    body: `"${variant.product.title}" (${variant.title}) has fallen below your low-stock threshold.`,
    link: `/sell/products/${variant.productId}`,
    dedupeKey: `low-stock:${variantId}:${alertCount}`,
  });
}

/**
 * Confirmed absent before this: `notifyOrderPaid` above only ever
 * notified the BUYER — a seller had zero real-time signal that they'd
 * made a sale, only whatever they happened to notice next time they
 * checked `/sell/orders`. Fans out to every DISTINCT seller with at
 * least one line in this order (a real, multi-vendor cart is genuinely
 * possible), one notification each — unlike `notifyBackInStock`'s fan-
 * out, there's no per-recipient "request" row to re-arm here, so a
 * plain `createOnce` per seller, keyed on (orderId, sellerId), is
 * enough: an order is paid exactly once, never re-armed the way a
 * stockout/restock cycle is.
 */
export async function notifySellersOfNewSale(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderNumber: true, lines: { select: { sellerId: true, quantity: true } } },
  });
  if (!order) return;

  const sellerIds = [...new Set(order.lines.map((l) => l.sellerId))];
  const sellers = await prisma.seller.findMany({
    where: { id: { in: sellerIds } },
    select: { id: true, ownerId: true },
  });

  for (const seller of sellers) {
    const lineCount = order.lines.filter((l) => l.sellerId === seller.id).length;
    await createOnce({
      userId: seller.ownerId,
      type: "NEW_SALE",
      title: `You made a sale — order ${order.orderNumber}`,
      body: `${lineCount} item${lineCount === 1 ? "" : "s"} from order ${order.orderNumber} just sold.`,
      link: `/sell/orders/${order.orderNumber}`,
      dedupeKey: `new-sale:${orderId}:${seller.id}`,
    });
  }
}

export async function listNotificationsForUser(userId: string, take = 50) {
  return prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take });
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markAsRead(userId: string, notificationId: string): Promise<void> {
  // Ownership via the WHERE clause itself, not a separate read-then-check:
  // updateMany on a non-owned id simply matches zero rows — the exact same
  // "indistinguishable from not existing" outcome a cross-user attempt gets
  // everywhere else in this codebase, with less code.
  await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function markAllAsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}
