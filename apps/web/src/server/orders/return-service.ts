/**
 * Return requests: buyer requests, seller-or-admin approves/rejects.
 *
 * Approving a return does three real things together, in one transaction:
 * restocks the variant's real inventory, moves the OrderLine to RETURNED
 * (excluded from the fulfilment aggregate — see fulfilment-aggregate.ts's
 * own comment), and reverses the seller's settlement via a real REFUND
 * ledger entry — never a mutable balance edit, same discipline as every
 * other financial fact in this schema. It does NOT trigger an actual
 * refund payment to the customer — see this file's own note below on why,
 * and settlement-service.ts's identical reasoning for seller payouts.
 */

import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";
import { enqueue } from "../outbox.js";
import { enqueueBackInStockCheck } from "../catalogue/back-in-stock-service.js";

export class ReturnError extends Error {
  override name = "ReturnError";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export async function requestReturn(userId: string, orderLineId: string, reason: string): Promise<void> {
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 10) {
    throw new ReturnError("Tell us more about why you're returning this item (at least 10 characters).");
  }

  const line = await prisma.orderLine.findUnique({ where: { id: orderLineId }, include: { order: true } });
  if (!line || line.order.userId !== userId) {
    throw new ReturnError("Order line not found.");
  }
  if (line.fulfilmentStatus !== "FULFILLED") {
    throw new ReturnError("You can only return an item that has actually been shipped.");
  }

  try {
    await prisma.returnRequest.create({
      data: { orderLineId, orderId: line.orderId, requestedByUserId: userId, reason: trimmedReason },
    });
    logger.info("return.requested", { orderLineId, userId });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ReturnError("A return has already been requested for this item.");
    }
    throw error;
  }
}

async function applyResolution(
  returnRequestId: string,
  resolverUserId: string,
  outcome: "APPROVED" | "REJECTED",
  note: string | undefined,
  authorize: (line: { sellerId: string }) => void,
): Promise<void> {
  const request = await prisma.returnRequest.findUnique({
    where: { id: returnRequestId },
    include: { orderLine: true },
  });
  if (!request) throw new ReturnError("Return request not found.");
  if (request.status !== "REQUESTED") {
    throw new ReturnError(`This request was already ${request.status.toLowerCase()}.`);
  }
  authorize(request.orderLine);

  if (outcome === "REJECTED") {
    await prisma.$transaction(async (tx) => {
      await tx.returnRequest.update({
        where: { id: returnRequestId },
        data: { status: "REJECTED", resolvedByUserId: resolverUserId, resolvedAt: new Date(), resolutionNote: note },
      });
      await enqueue(tx, "return.resolved", { returnRequestId });
    });
    logger.info("return.rejected", { returnRequestId, resolverUserId });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.returnRequest.update({
      where: { id: returnRequestId },
      data: { status: "APPROVED", resolvedByUserId: resolverUserId, resolvedAt: new Date(), resolutionNote: note },
    });

    await tx.orderLine.update({
      where: { id: request.orderLineId },
      data: { fulfilmentStatus: "RETURNED" },
    });

    if (request.orderLine.variantId) {
      // A real, atomic increment (Prisma compiles this to a single
      // `SET "onHand" = "onHand" + $1`, not a read-then-write) — restocked
      // inventory is immediately available to sell again.
      await tx.inventory.update({
        where: { variantId: request.orderLine.variantId },
        data: { onHand: { increment: request.orderLine.quantity } },
      });
      await enqueueBackInStockCheck(tx, request.orderLine.variantId);
    }

    // Reverse the settlement: the SALE and COMMISSION entries this line
    // already has stay exactly as they were (immutable, append-only — see
    // schema.prisma's own comment on why), and a REFUND entry is added
    // that cancels out the net. Idempotent for the same reason
    // settlement-service.ts's entries are: a unique (orderLineId, type)
    // constraint, so this can safely run at most once per line.
    const existingEntries = await tx.sellerLedgerEntry.findMany({
      where: { orderLineId: request.orderLineId, type: { in: ["SALE", "COMMISSION"] } },
    });
    const netPreviouslyCredited = existingEntries.reduce((sum, e) => sum + e.amountSantim, 0);

    if (netPreviouslyCredited !== 0) {
      try {
        await tx.sellerLedgerEntry.create({
          data: {
            sellerId: request.orderLine.sellerId,
            orderId: request.orderId,
            orderLineId: request.orderLineId,
            type: "REFUND",
            amountSantim: -netPreviouslyCredited,
            description: `Return approved for ${request.orderLine.productTitle}`,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Already reversed — a retried call, not a bug.
      }
    }

    await enqueue(tx, "return.resolved", { returnRequestId });
  });

  logger.info("return.approved", { returnRequestId, resolverUserId, orderLineId: request.orderLineId });
}

/** Only the seller who owns this line's product may approve/reject it. */
export async function approveReturnAsSeller(sellerId: string, returnRequestId: string, note?: string): Promise<void> {
  await applyResolution(returnRequestId, sellerId, "APPROVED", note, (line) => {
    if (line.sellerId !== sellerId) throw new ReturnError("Return request not found.");
  });
}

export async function rejectReturnAsSeller(sellerId: string, returnRequestId: string, note?: string): Promise<void> {
  await applyResolution(returnRequestId, sellerId, "REJECTED", note, (line) => {
    if (line.sellerId !== sellerId) throw new ReturnError("Return request not found.");
  });
}

/** Admin override — any return request, regardless of seller (dispute escalation). */
export async function approveReturnAsAdmin(adminUserId: string, returnRequestId: string, note?: string): Promise<void> {
  await applyResolution(returnRequestId, adminUserId, "APPROVED", note, () => {});
}

export async function rejectReturnAsAdmin(adminUserId: string, returnRequestId: string, note?: string): Promise<void> {
  await applyResolution(returnRequestId, adminUserId, "REJECTED", note, () => {});
}

export async function listReturnRequestsForSeller(sellerId: string) {
  return prisma.returnRequest.findMany({
    where: { orderLine: { sellerId } },
    orderBy: { createdAt: "desc" },
    include: { orderLine: true, order: { select: { orderNumber: true } } },
  });
}

export async function listAllReturnRequests() {
  return prisma.returnRequest.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      orderLine: true,
      order: { select: { orderNumber: true } },
      requestedBy: { select: { email: true } },
    },
  });
}
