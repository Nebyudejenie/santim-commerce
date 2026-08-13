"use server";

/**
 * Admin mutations.
 *
 * `resettlePaymentAction` is the manual escape hatch that mirrors what the
 * poller and reconciler already do automatically (payment-service.ts's
 * `settlePayment`) — this is the SAME function, just triggered by a human
 * clicking a button instead of a timer. That reuse matters: a "manual override"
 * path that reimplements settlement logic separately is exactly how a payment
 * system ends up with two different opinions about what counts as paid.
 */

import { revalidatePath } from "next/cache";
import { settlePayment } from "../payments/payment-service.js";
import { logger } from "../observability/logger.js";

export interface AdminActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function resettlePaymentAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const merchantTxnId = String(formData.get("merchantTxnId") ?? "");
  const orderNumber = String(formData.get("orderNumber") ?? "");
  if (!merchantTxnId) return { ok: false, message: "Missing transaction id." };

  try {
    const result = await settlePayment(merchantTxnId, "manual");
    revalidatePath("/admin/reconciliation");
    if (orderNumber) revalidatePath(`/admin/orders/${orderNumber}`);

    logger.info("admin.manual_resettle", { merchantTxnId, status: result.status, changed: result.changed });

    return {
      ok: true,
      message: result.changed
        ? `Updated to ${result.status}.`
        : `No change — gateway still reports the same state (${result.status}).`,
    };
  } catch (error) {
    logger.error("admin.manual_resettle_failed", { merchantTxnId, error: (error as Error).message });
    return { ok: false, message: (error as Error).message };
  }
}
