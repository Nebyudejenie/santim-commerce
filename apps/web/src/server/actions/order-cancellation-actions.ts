"use server";

/**
 * Order cancellation — checks its own authorization via requireUser, same
 * in-action-auth discipline as every other action in this codebase.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "../auth/guard.js";
import { cancelOrder, OrderCancellationError } from "../orders/order-cancellation-service.js";
import { logger } from "../observability/logger.js";

export interface OrderCancellationActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function cancelOrderAction(
  _prev: OrderCancellationActionState,
  formData: FormData,
): Promise<OrderCancellationActionState> {
  const user = await requireUser();
  const orderNumber = String(formData.get("orderNumber") ?? "");
  if (!orderNumber) return { ok: false, message: "Missing order." };

  try {
    await cancelOrder(user.id, orderNumber);
  } catch (error) {
    if (error instanceof OrderCancellationError) return { ok: false, message: error.message };
    logger.error("order.cancel_action_failed", { orderNumber, userId: user.id, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/account/orders/${orderNumber}`);
  revalidatePath("/account");
  return { ok: true, message: "Your order has been cancelled." };
}
