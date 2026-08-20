"use server";

/**
 * Seller fulfilment mutations — checks its own authorization via
 * requireApprovedSeller, same in-action-auth discipline as every other
 * action added this session (see admin-actions.ts's module comment for
 * why: a Server Action is its own independently-invokable endpoint, never
 * just gated by the page that renders its trigger form).
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "../auth/guard.js";
import { requireApprovedSeller, SellerError } from "../sellers/seller-service.js";
import { FulfilmentError, markLineFulfilled, markLineUnfulfilled } from "../orders/seller-order-fulfillment.js";
import { logger } from "../observability/logger.js";

export interface FulfilmentActionState {
  readonly ok: boolean;
  readonly message?: string;
}

async function sellerIdOrState(): Promise<string | FulfilmentActionState> {
  const user = await requireUser();
  try {
    const seller = await requireApprovedSeller(user.id);
    return seller.id;
  } catch (error) {
    return { ok: false, message: error instanceof SellerError ? error.message : "Not authorized." };
  }
}

async function runTransition(
  formData: FormData,
  transition: (sellerId: string, orderLineId: string) => Promise<void>,
): Promise<FulfilmentActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const orderLineId = String(formData.get("orderLineId") ?? "");
  const orderNumber = String(formData.get("orderNumber") ?? "");

  try {
    await transition(sellerId, orderLineId);
  } catch (error) {
    if (error instanceof FulfilmentError) return { ok: false, message: error.message };
    logger.error("fulfilment.action_failed", { orderLineId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (orderNumber) revalidatePath(`/sell/orders/${orderNumber}`);
  return { ok: true };
}

export async function markLineFulfilledAction(
  _prev: FulfilmentActionState,
  formData: FormData,
): Promise<FulfilmentActionState> {
  return runTransition(formData, markLineFulfilled);
}

export async function markLineUnfulfilledAction(
  _prev: FulfilmentActionState,
  formData: FormData,
): Promise<FulfilmentActionState> {
  return runTransition(formData, markLineUnfulfilled);
}
