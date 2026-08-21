/**
 * Payment orchestration — the heart of the integration.
 *
 * THE THREE-LAYER RULE
 * --------------------
 * Money state is decided by exactly one function: `settlePayment`. The webhook
 * does not decide. The browser redirect certainly does not decide. They only
 * TRIGGER a settlement, which then asks SantimPay's status API what is true and
 * applies the answer through a state machine inside a database transaction.
 *
 *   webhook  ──┐
 *   poller   ──┼──▶ settlePayment(merchantTxnId) ──▶ status API ──▶ txn commit
 *   reconciler─┘
 *
 * Three independent triggers, one decision path. Any of them can fail, be
 * duplicated, or arrive out of order without corrupting anything.
 */

import { ulid } from "ulid";
import {
  DuplicateReferenceError,
  SantimPayError,
  assertAmountMatches,
  verifyWebhook,
  type Transaction,
} from "@santim/santimpay";
import { prisma, type Tx } from "../db.js";
import { env, urls } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { enqueue } from "../outbox.js";
import { enqueueLowStockCheck } from "../catalogue/low-stock-service.js";
import { santimpay } from "./santimpay-client.js";
import {
  assertOrderTransition,
  decidePaymentTransition,
  nextPollDelaySeconds,
  orderStatusForPayment,
  type PaymentStatus,
} from "../orders/state-machine.js";
import {
  checkoutSessionsTotal,
  paymentAmountMismatchTotal,
  paymentSettlementsTotal,
  timeGatewayCall,
  webhookRequestsTotal,
} from "../observability/metrics.js";

/* ============================================================ 1. INITIATION */

export interface StartPaymentResult {
  readonly paymentUrl: string;
  readonly merchantTxnId: string;
}

/**
 * Create a payment intent and a hosted checkout session.
 *
 * ORDERING IS THE WHOLE POINT. The intent row is committed BEFORE the gateway
 * is called. If the process dies immediately after the gateway accepts the
 * request, the reconciler finds the intent by `merchantTxnId` and recovers the
 * payment. Had we called first and saved after, that customer would be charged
 * for an order we have no record of — the single worst outcome in commerce.
 */
export async function startPayment(orderId: string): Promise<StartPaymentResult> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { payments: true },
  });

  if (order.status !== "PENDING_PAYMENT") {
    throw new PaymentServiceError(
      `Order ${order.orderNumber} is ${order.status}; only PENDING_PAYMENT orders can start a payment.`,
    );
  }

  // Reuse an in-flight intent rather than creating a second one. A customer
  // double-clicking "Pay" must not produce two payment attempts.
  const reusable = order.payments.find(
    (p) => (p.status === "CREATED" || p.status === "PENDING") && p.paymentUrl,
  );
  if (reusable?.paymentUrl) {
    logger.info("payment.reusing_intent", {
      orderId,
      merchantTxnId: reusable.merchantTxnId,
    });
    return { paymentUrl: reusable.paymentUrl, merchantTxnId: reusable.merchantTxnId };
  }

  // ULID rather than UUIDv4: lexicographically sortable by creation time, so
  // support can eyeball ordering and the DB index stays sequential.
  const merchantTxnId = ulid();

  const intent = await prisma.paymentIntent.create({
    data: {
      orderId: order.id,
      merchantTxnId,
      amountSantim: order.totalSantim,
      currency: order.currency,
      status: "CREATED",
    },
  });

  const link = urls();

  try {
    const { paymentUrl } = await timeGatewayCall("initiate-payment", () =>
      santimpay().createCheckoutSession({
        transactionId: merchantTxnId,
        amount: order.totalSantim as never, // branded Santim; both are integers
        reason: `Order ${order.orderNumber}`,
        successRedirectUrl: link.checkoutSuccess(order.orderNumber),
        failureRedirectUrl: link.checkoutFailed(order.orderNumber),
        cancelRedirectUrl: link.checkoutCancelled(order.orderNumber),
        notifyUrl: link.webhook,
        phoneNumber: order.phone,
      }),
    );

    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: "PENDING",
          paymentUrl,
          nextPollAt: new Date(Date.now() + (nextPollDelaySeconds(0) ?? 5) * 1000),
        },
      }),
      prisma.orderEvent.create({
        data: {
          orderId: order.id,
          type: "payment.initiated",
          message: `Checkout session created (${merchantTxnId})`,
          actor: "system",
        },
      }),
    ]);

    logger.info("payment.initiated", { orderId, merchantTxnId, orderNumber: order.orderNumber });
    checkoutSessionsTotal.inc({ outcome: "created" });
    return { paymentUrl, merchantTxnId };
  } catch (error) {
    // A duplicate reference means SantimPay already has this id. That is not a
    // failure — the original attempt may be succeeding right now. Resolve it
    // by asking, never by telling the customer their payment failed.
    if (error instanceof DuplicateReferenceError) {
      logger.warn("payment.duplicate_reference", { orderId, merchantTxnId });
      await settlePayment(merchantTxnId, "duplicate-recovery");
      const refreshed = await prisma.paymentIntent.findUniqueOrThrow({ where: { merchantTxnId } });
      if (refreshed.paymentUrl) {
        checkoutSessionsTotal.inc({ outcome: "duplicate_recovered" });
        return { paymentUrl: refreshed.paymentUrl, merchantTxnId };
      }
    }

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "FAILED",
        failureCode: error instanceof SantimPayError ? error.kind : "unknown",
        failureMessage: (error as Error).message.slice(0, 1000),
      },
    });

    logger.error("payment.initiation_failed", {
      orderId,
      merchantTxnId,
      error: (error as Error).message,
    });
    checkoutSessionsTotal.inc({ outcome: "failed" });
    throw error;
  }
}

/* =============================================================== 2. WEBHOOK */

export interface WebhookResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly merchantTxnId: string | null;
}

/**
 * Record an inbound callback. Deliberately does NOT settle.
 *
 * The HTTP handler must answer 200 in well under a couple of seconds or the
 * gateway assumes failure and redelivers — and a redelivery storm during an
 * outage is how a small problem becomes a large one. So this function does the
 * minimum durable work (verify + persist) and hands settlement to the worker.
 */
export async function recordWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookResult> {
  const cfg = env();

  // Verify BEFORE parsing into anything the application touches. An unsigned
  // callback never reaches business logic.
  const { transaction } = verifyWebhook({
    rawBody,
    headers,
    privateKeyPem: cfg.SANTIMPAY_PRIVATE_KEY,
    maxAgeSeconds: cfg.WEBHOOK_MAX_AGE_SECONDS,
  });

  const intent = await prisma.paymentIntent.findUnique({
    where: { merchantTxnId: transaction.merchantTransactionId },
  });

  try {
    // The unique constraint on (provider, gatewayTxnId, status) is what makes
    // duplicate delivery a no-op. We rely on the DATABASE for this, not on an
    // in-memory set — application-level dedupe does not survive a restart and
    // does not work across replicas.
    await prisma.webhookEvent.create({
      data: {
        provider: "santimpay",
        gatewayTxnId: transaction.gatewayTransactionId,
        status: transaction.raw.status ?? "UNKNOWN",
        paymentIntentId: intent?.id ?? null,
        rawBody,
        signature: String(headers["signed-token"] ?? headers["Signed-Token"] ?? ""),
        signatureValid: true,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      logger.info("webhook.duplicate", {
        gatewayTxnId: transaction.gatewayTransactionId,
        status: transaction.raw.status,
      });
      webhookRequestsTotal.inc({ result: "duplicate" });
      return {
        accepted: true,
        duplicate: true,
        merchantTxnId: transaction.merchantTransactionId,
      };
    }
    throw error;
  }

  if (!intent) {
    // A callback for an id we never issued. Either a stale test, or someone
    // probing. Recorded and alerted, never acted on.
    logger.error("webhook.unknown_intent", {
      merchantTxnId: transaction.merchantTransactionId,
      gatewayTxnId: transaction.gatewayTransactionId,
    });
    webhookRequestsTotal.inc({ result: "unknown_intent" });
    return { accepted: true, duplicate: false, merchantTxnId: null };
  }

  logger.info("webhook.recorded", {
    merchantTxnId: transaction.merchantTransactionId,
    status: transaction.raw.status,
  });
  webhookRequestsTotal.inc({ result: "accepted" });

  return {
    accepted: true,
    duplicate: false,
    merchantTxnId: transaction.merchantTransactionId,
  };
}

/* ============================================================= 3. SETTLEMENT */

export type SettlementTrigger = "webhook" | "poller" | "reconciler" | "duplicate-recovery" | "manual";

export interface SettlementResult {
  readonly merchantTxnId: string;
  readonly status: PaymentStatus;
  readonly changed: boolean;
  readonly reason?: string;
}

/**
 * Ask SantimPay what is true, then make our database agree — atomically.
 *
 * Safe to call concurrently and repeatedly from every trigger. The state
 * machine turns a redundant call into a no-op instead of a double fulfilment.
 */
export async function settlePayment(
  merchantTxnId: string,
  trigger: SettlementTrigger,
): Promise<SettlementResult> {
  const intent = await prisma.paymentIntent.findUniqueOrThrow({
    where: { merchantTxnId },
    include: { order: true },
  });

  // Authoritative read. NOT the webhook body — see the module header.
  const transaction = await timeGatewayCall("fetch-transaction-status", () =>
    santimpay().fetchTransactionStatus(merchantTxnId),
  );

  // The check almost every integration omits. If the gateway reports an amount
  // that differs from what we recorded, something is very wrong: a gateway bug,
  // a tampered request, or a mixed-up id. Never fulfil; always alert.
  try {
    assertAmountMatches(transaction, intent.amountSantim);
  } catch (error) {
    logger.error("payment.amount_mismatch", {
      merchantTxnId,
      expectedSantim: intent.amountSantim,
      reportedSantim: transaction.amountSantim,
      orderId: intent.orderId,
    });
    paymentAmountMismatchTotal.inc();
    await prisma.orderEvent.create({
      data: {
        orderId: intent.orderId,
        type: "payment.amount_mismatch",
        message: (error as Error).message,
        actor: trigger,
        data: transaction.raw as object,
      },
    });
    throw error;
  }

  const decision = decidePaymentTransition(intent.status as PaymentStatus, transaction.status);

  if (decision.action === "ignore") {
    logger.info("payment.transition_ignored", {
      merchantTxnId,
      trigger,
      from: decision.from,
      to: decision.to,
      reason: decision.reason,
    });
    return {
      merchantTxnId,
      status: intent.status as PaymentStatus,
      changed: false,
      reason: decision.reason,
    };
  }

  await prisma.$transaction(async (tx) => {
    await applyPaymentTransition(tx, {
      intentId: intent.id,
      orderId: intent.orderId,
      orderStatus: intent.order.status,
      transaction,
      to: decision.to,
      trigger,
    });
  });

  logger.info("payment.settled", {
    merchantTxnId,
    trigger,
    from: decision.from,
    to: decision.to,
    channel: transaction.channel,
  });
  paymentSettlementsTotal.inc({ trigger, status: decision.to });

  return { merchantTxnId, status: decision.to, changed: true };
}

interface ApplyInput {
  intentId: string;
  orderId: string;
  orderStatus: string;
  transaction: Transaction;
  to: PaymentStatus;
  trigger: SettlementTrigger;
}

/**
 * Everything that must be true together, committed together.
 *
 * Payment status, order status, inventory, audit trail, and outbound side
 * effects all live in ONE transaction. If any part fails, none of it happened —
 * so there is no state in which a customer is charged but stock was never
 * deducted, or an order is PAID with no audit event explaining why.
 */
async function applyPaymentTransition(tx: Tx, input: ApplyInput): Promise<void> {
  const { transaction, to } = input;

  await tx.paymentIntent.update({
    where: { id: input.intentId },
    data: {
      status: to,
      gatewayTxnId: transaction.gatewayTransactionId || null,
      channelRef: transaction.channelReference,
      channel: transaction.channel,
      msisdn: transaction.msisdn,
      commissionSantim: transaction.commissionSantim,
      totalSantim: transaction.totalSantim,
      failureMessage: to === "COMPLETED" ? null : transaction.message,
      completedAt: to === "COMPLETED" ? new Date() : null,
      nextPollAt: to === "COMPLETED" || to === "FAILED" || to === "DECLINED" ? null : undefined,
    },
  });

  const nextOrderStatus = orderStatusForPayment(to);
  if (!nextOrderStatus) return;

  assertOrderTransition(input.orderStatus as never, nextOrderStatus as never, input.orderId);

  await tx.order.update({
    where: { id: input.orderId },
    data: {
      status: nextOrderStatus,
      paidAt: nextOrderStatus === "PAID" ? new Date() : undefined,
      cancelledAt: nextOrderStatus === "CANCELLED" ? new Date() : undefined,
    },
  });

  if (nextOrderStatus === "PAID") {
    await commitReservations(tx, input.orderId);
    // Side effects go through the outbox, never through a direct API call
    // inside a transaction: you cannot roll back an email that has been sent.
    await enqueue(tx, "order.paid", {
      orderId: input.orderId,
      channel: transaction.channel,
      channelRef: transaction.channelReference,
    });
  } else {
    await releaseReservations(tx, input.orderId);
    await enqueue(tx, "order.payment_failed", {
      orderId: input.orderId,
      reason: transaction.message,
    });
  }

  await tx.orderEvent.create({
    data: {
      orderId: input.orderId,
      type: `payment.${to.toLowerCase()}`,
      message: transaction.message ?? `Payment ${to}`,
      actor: input.trigger,
      data: {
        gatewayTxnId: transaction.gatewayTransactionId,
        channel: transaction.channel,
        channelRef: transaction.channelReference,
        amountSantim: transaction.amountSantim,
        commissionSantim: transaction.commissionSantim,
      },
    },
  });
}

/* =========================================================== 4. INVENTORY */

/** Payment succeeded: turn the hold into a real deduction. */
async function commitReservations(tx: Tx, orderId: string): Promise<void> {
  const held = await tx.inventoryReservation.findMany({
    where: { orderId, status: "HELD" },
  });

  for (const reservation of held) {
    await tx.inventory.update({
      where: { variantId: reservation.variantId },
      data: {
        onHand: { decrement: reservation.quantity },
        reserved: { decrement: reservation.quantity },
      },
    });
    await tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: "COMMITTED" },
    });
    // A real, committed sale — the meaningful signal for a seller to act
    // on, unlike a still-reversible HELD reservation. Same transaction as
    // the real inventory write, side effects through the outbox only —
    // see low-stock-service.ts's own comment.
    await enqueueLowStockCheck(tx, reservation.variantId);
  }
}

/** Payment failed or expired: give the stock back to the next customer. */
async function releaseReservations(tx: Tx, orderId: string): Promise<void> {
  const held = await tx.inventoryReservation.findMany({
    where: { orderId, status: "HELD" },
  });

  for (const reservation of held) {
    await tx.inventory.update({
      where: { variantId: reservation.variantId },
      data: { reserved: { decrement: reservation.quantity } },
    });
    await tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: "RELEASED" },
    });
  }
}

/* =============================================================== helpers */

export class PaymentServiceError extends Error {
  override name = "PaymentServiceError";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}
