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
 *
 * `requireRole` is called INSIDE this action, not just relied on via the
 * `(dashboard)` layout that happens to render the button triggering it —
 * a Server Action is its own independently-invokable endpoint (Next.js's
 * own security guidance: treat Server Actions as public HTTP endpoints),
 * identified by a stable reference compiled into the client bundle. A
 * page-level `requireRole` check gates the PAGE RENDER; it does not gate
 * a direct POST to the action itself. This was a real, found-not-assumed
 * gap — grep confirmed zero server actions anywhere in this codebase
 * called requireRole/requireUser before this fix.
 */

import { revalidatePath } from "next/cache";
import { settlePayment } from "../payments/payment-service.js";
import { setProductFeaturedAsAdmin } from "../catalogue/listing-service.js";
import { logger } from "../observability/logger.js";
import { requireRole } from "../auth/guard.js";

export interface AdminActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function resettlePaymentAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole("STAFF"); // redirects to /admin/login if this fails — see module comment
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

export async function toggleProductFeaturedAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole("STAFF");

  const productId = String(formData.get("productId") ?? "");
  const featured = formData.get("featured") === "true";

  try {
    await setProductFeaturedAsAdmin(productId, featured);
  } catch (error) {
    logger.error("admin.toggle_featured_failed", { productId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/admin/products");
  revalidatePath("/");
  return { ok: true, message: featured ? "Marked featured." : "Removed from featured." };
}
