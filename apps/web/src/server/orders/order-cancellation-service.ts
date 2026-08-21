/**
 * Customer-initiated order cancellation. The state machine (state-machine.ts)
 * already declared PENDING_PAYMENT -> CANCELLED and PAID -> CANCELLED as
 * legal transitions from the very first version of this codebase — this is
 * the first thing that actually exercises them from the customer side.
 *
 * Only legal while `Order.fulfilmentStatus` is still UNFULFILLED — the
 * moment ANY seller has shipped ANY line, the customer must use the
 * existing returns flow (return-service.ts) instead, which operates
 * per-line rather than cancelling the whole order outright.
 *
 * A PAID order's reversal mirrors return-service.ts's own REFUND-ledger
 * pattern exactly, for the same reason: the SALE/COMMISSION entries stay
 * immutable and a REFUND entry cancels out the net, never a mutable
 * balance edit. This does NOT trigger an actual refund payment to the
 * customer — same real-gateway-confirmation limit already documented for
 * returns and payouts.
 */

import { prisma, type Tx } from "../db.js";
import { logger } from "../observability/logger.js";
import { enqueueBackInStockCheck } from "../catalogue/back-in-stock-service.js";

export class OrderCancellationError extends Error {
  override name = "OrderCancellationError";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

async function releaseHeldReservations(tx: Tx, orderId: string): Promise<void> {
  const held = await tx.inventoryReservation.findMany({ where: { orderId, status: "HELD" } });
  for (const reservation of held) {
    await tx.inventory.update({
      where: { variantId: reservation.variantId },
      data: { reserved: { decrement: reservation.quantity } },
    });
    await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED" } });
  }
}

async function restockAndReverseSettlement(
  tx: Tx,
  order: { id: string; orderNumber: string },
  lines: readonly { id: string; variantId: string | null; sellerId: string; productTitle: string; quantity: number }[],
): Promise<void> {
  for (const line of lines) {
    if (line.variantId) {
      // A real, atomic increment — same pattern as return-service.ts's
      // own restock, and for the same reason it also runs a real
      // back-in-stock check: a cancellation can be the exact event a
      // waiting customer needed.
      await tx.inventory.update({ where: { variantId: line.variantId }, data: { onHand: { increment: line.quantity } } });
      await enqueueBackInStockCheck(tx, line.variantId);
    }

    const existingEntries = await tx.sellerLedgerEntry.findMany({
      where: { orderLineId: line.id, type: { in: ["SALE", "COMMISSION"] } },
    });
    const netPreviouslyCredited = existingEntries.reduce((sum, e) => sum + e.amountSantim, 0);
    if (netPreviouslyCredited === 0) continue;

    try {
      await tx.sellerLedgerEntry.create({
        data: {
          sellerId: line.sellerId,
          orderId: order.id,
          orderLineId: line.id,
          type: "REFUND",
          amountSantim: -netPreviouslyCredited,
          description: `Order cancelled: ${line.productTitle} (order ${order.orderNumber})`,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Already reversed — a retried call, not a bug.
    }
  }
}

export async function cancelOrder(userId: string, orderNumber: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: { lines: true } });
  if (!order || order.userId !== userId) {
    throw new OrderCancellationError("Order not found.");
  }
  if (order.fulfilmentStatus !== "UNFULFILLED") {
    throw new OrderCancellationError("This order has already started shipping and can no longer be cancelled — request a return instead.");
  }
  // Deliberately NOT assertOrderTransition here: its "from === to is a
  // silent no-op" rule is correct for webhook reprocessing (a redelivered
  // callback that already applied must not error) but wrong for a
  // user-initiated action — a second cancel attempt on an ALREADY-
  // cancelled order must be a real, surfaced rejection, not silently
  // "succeed" a second time and re-run the reversal logic. A real bug,
  // caught by this file's own integration test before it shipped: without
  // this explicit check, CANCELLED -> CANCELLED short-circuited past
  // assertOrderTransition, and the atomic conditional update below (which
  // only checks status hasn't changed since the read, not which status it
  // legitimately came from) then happily "reaffirmed" the same status and
  // proceeded to double-restock inventory.
  if (order.status !== "PENDING_PAYMENT" && order.status !== "PAID") {
    throw new OrderCancellationError(`This order is already ${order.status.toLowerCase().replace(/_/g, " ")} and cannot be cancelled.`);
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: order.id, status: order.status },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new OrderCancellationError("This order was just updated elsewhere — please refresh and try again.");
    }

    if (order.status === "PENDING_PAYMENT") {
      await releaseHeldReservations(tx, order.id);
    } else {
      await restockAndReverseSettlement(tx, order, order.lines);
    }

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "order.cancelled",
        message: "Cancelled by the customer",
        actor: userId,
      },
    });
  });

  logger.info("order.cancelled", { orderId: order.id, orderNumber, userId, fromStatus: order.status });
}
