/**
 * Shipping label generation — curriculum Phase 12 §2 / Lab 12.2, built for
 * real against this codebase rather than left as a description.
 *
 * THE ORDERING RULE, same as startPayment() (payments/payment-service.ts)
 * The idempotency key is generated and the row persisted BEFORE the carrier
 * is ever called. If a crash or a retry lands between "we decided to
 * generate a label" and "the carrier confirmed it," the label row survives
 * and this function can safely resume — never mint a second, billable
 * label because the first attempt's outcome was unknown.
 *
 * THE CONCURRENCY RULE, same as reservation.ts / recordWebhook()
 * `ShippingLabel.orderId` is `@unique` in the schema. That constraint — not
 * a check-then-create in this function — is what makes two concurrent
 * requests for the same order safe: the loser of the race gets a real
 * Postgres unique-violation error, not a silently-created duplicate row.
 * This function's own "does a label already exist" check is an
 * optimization to skip redundant work, never the actual safety mechanism.
 */

import { ulid } from "ulid";
import { prisma } from "../db.js";
import { generateLabel, type LabelResult } from "./carrier-client.js";
import { logger } from "../observability/logger.js";

export class ShippingLabelError extends Error {
  override name = "ShippingLabelError";
}

export interface GenerateShippingLabelResult {
  readonly trackingNumber: string;
  readonly labelUrl: string;
}

export async function generateShippingLabel(orderId: string): Promise<GenerateShippingLabelResult> {
  let label = await prisma.shippingLabel.findUnique({ where: { orderId } });

  if (!label) {
    try {
      // Key generated and persisted BEFORE the carrier is ever called —
      // the exact ordering startPayment() uses for merchantTxnId.
      label = await prisma.shippingLabel.create({
        data: { orderId, idempotencyKey: ulid(), status: "PENDING" },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost the race to a concurrent call for the same order — that call's
      // row is the authoritative one now; use it instead of erroring.
      label = await prisma.shippingLabel.findUniqueOrThrow({ where: { orderId } });
    }
  }

  if (label.status === "GENERATED" && label.trackingNumber && label.labelUrl) {
    return { trackingNumber: label.trackingNumber, labelUrl: label.labelUrl };
  }

  let result: LabelResult;
  try {
    result = await generateLabel({ idempotencyKey: label.idempotencyKey, orderId });
  } catch (error) {
    await prisma.shippingLabel.update({
      where: { id: label.id },
      data: { status: "FAILED", failureMessage: (error as Error).message.slice(0, 1000) },
    });
    throw new ShippingLabelError(`Failed to generate shipping label: ${(error as Error).message}`);
  }

  const updated = await prisma.shippingLabel.update({
    where: { id: label.id },
    data: {
      status: "GENERATED",
      carrierLabelId: result.carrierLabelId,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      completedAt: new Date(),
    },
  });

  logger.info("shipping.label_generated", { orderId, idempotencyKey: label.idempotencyKey });
  return { trackingNumber: updated.trackingNumber!, labelUrl: updated.labelUrl! };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}
