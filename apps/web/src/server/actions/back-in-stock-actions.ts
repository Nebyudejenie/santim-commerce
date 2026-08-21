"use server";

/**
 * Back-in-stock request mutation — checks its own authorization via
 * requireUser, same in-action-auth discipline as every other action in
 * this codebase.
 */

import { requireUser } from "../auth/guard.js";
import { requestBackInStockNotification, BackInStockError } from "../catalogue/back-in-stock-service.js";
import { logger } from "../observability/logger.js";

export interface BackInStockActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function requestBackInStockAction(
  _prev: BackInStockActionState,
  formData: FormData,
): Promise<BackInStockActionState> {
  const user = await requireUser();
  const variantId = String(formData.get("variantId") ?? "");
  if (!variantId) return { ok: false, message: "Missing item." };

  try {
    await requestBackInStockNotification(user.id, variantId);
  } catch (error) {
    if (error instanceof BackInStockError) return { ok: false, message: error.message };
    logger.error("back_in_stock.request_action_failed", { userId: user.id, variantId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  return { ok: true, message: "We'll notify you here when this is back in stock." };
}
