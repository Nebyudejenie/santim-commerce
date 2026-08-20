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
  type: "ORDER_PAID" | "ORDER_PAYMENT_FAILED" | "ORDER_LINE_FULFILLED" | "RETURN_APPROVED" | "RETURN_REJECTED";
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
