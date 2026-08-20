/**
 * Seller-facing fulfilment mutations: mark my own line shipped (or undo
 * that if it was a mistake), then recompute the Order's own
 * fulfilmentStatus as the derived aggregate of ALL its lines — see
 * fulfilment-aggregate.ts's module comment for why that has to be derived,
 * not a second field a seller directly sets.
 *
 * RETURNED is deliberately not a transition this module offers — that's
 * the future returns-workflow's job (a return needs a request/approval
 * flow, not a seller unilaterally flipping a status), not something to
 * half-build here.
 */

import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";
import { deriveOrderFulfilmentStatus, type LineFulfilmentStatus } from "./fulfilment-aggregate.js";

export class FulfilmentError extends Error {
  override name = "FulfilmentError";
}

async function setLineFulfilmentStatus(sellerId: string, orderLineId: string, status: "FULFILLED" | "UNFULFILLED") {
  const line = await prisma.orderLine.findUnique({ where: { id: orderLineId } });
  if (!line || line.sellerId !== sellerId) {
    throw new FulfilmentError("Order line not found.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.orderLine.update({
      where: { id: orderLineId },
      data: { fulfilmentStatus: status, fulfilledAt: status === "FULFILLED" ? new Date() : null },
    });

    const siblingLines = await tx.orderLine.findMany({
      where: { orderId: line.orderId },
      select: { fulfilmentStatus: true },
    });
    const statuses = siblingLines.map((l) => l.fulfilmentStatus as LineFulfilmentStatus);
    const derived = deriveOrderFulfilmentStatus(statuses);

    await tx.order.update({ where: { id: line.orderId }, data: { fulfilmentStatus: derived } });
  });

  logger.info("fulfilment.line_status_changed", { orderLineId, sellerId, status });
}

export async function markLineFulfilled(sellerId: string, orderLineId: string): Promise<void> {
  await setLineFulfilmentStatus(sellerId, orderLineId, "FULFILLED");
}

export async function markLineUnfulfilled(sellerId: string, orderLineId: string): Promise<void> {
  await setLineFulfilmentStatus(sellerId, orderLineId, "UNFULFILLED");
}
