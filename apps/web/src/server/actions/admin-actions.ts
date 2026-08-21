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
import { recordSellerPayout, SettlementError } from "../orders/settlement-service.js";
import { issuePasswordResetToken, PasswordResetError } from "../auth/password-reset-service.js";
import { suspendUser, reinstateUser, AuthError } from "../auth/auth-service.js";
import { logger } from "../observability/logger.js";
import { requireRole } from "../auth/guard.js";

export interface AdminActionState {
  readonly ok: boolean;
  readonly message?: string;
}

// Same fallback/normalization as sitemap.ts and robots.ts — the one
// existing convention in this codebase for building an absolute URL.
const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export interface IssueResetTokenState {
  readonly ok: boolean;
  readonly message?: string;
  readonly resetUrl?: string;
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

/**
 * Records a payout the admin has ALREADY sent outside this system — see
 * settlement-service.ts's own comment on `recordSellerPayout`. This
 * action does not move any money; it only records that a real, off-
 * system payout already happened.
 */
export async function recordSellerPayoutAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole("STAFF");

  const sellerId = String(formData.get("sellerId") ?? "");
  if (!sellerId) return { ok: false, message: "Missing seller." };

  try {
    const result = await recordSellerPayout(sellerId);
    revalidatePath("/admin/payouts");
    logger.info("admin.payout_recorded", { sellerId, settledSantim: result.settledSantim });
    return { ok: true, message: `Recorded a payout of ${(result.settledSantim / 100).toFixed(2)} ETB.` };
  } catch (error) {
    if (error instanceof SettlementError) return { ok: false, message: error.message };
    logger.error("admin.payout_record_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

/**
 * Issues a real, single-use password reset link and returns it to the
 * admin ONCE, for them to relay to the user through their own real,
 * off-system channel — see password-reset-service.ts's module comment for
 * why this is the honest alternative to a self-service "email me a link"
 * flow this codebase cannot honestly build. The raw token is never stored
 * anywhere and never displayed again after this response.
 */
export async function issuePasswordResetTokenAction(
  _prev: IssueResetTokenState,
  formData: FormData,
): Promise<IssueResetTokenState> {
  const admin = await requireRole("STAFF");

  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user." };

  try {
    const { rawToken } = await issuePasswordResetToken(userId, admin.email);
    logger.info("admin.password_reset_issued", { userId, issuedByAdmin: admin.email });
    return { ok: true, resetUrl: `${APP_URL}/reset-password/${rawToken}` };
  } catch (error) {
    if (error instanceof PasswordResetError) return { ok: false, message: error.message };
    logger.error("admin.password_reset_issue_failed", { userId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

/**
 * Trust & safety — see auth-service.ts's `suspendUser` for the real scope
 * (CUSTOMER accounts only) and why this also kills every existing session,
 * not just future logins.
 */
export async function suspendUserAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireRole("STAFF");

  const userId = String(formData.get("userId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (!userId) return { ok: false, message: "Missing user." };

  try {
    await suspendUser(userId, reason, admin.email);
    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
    logger.warn("admin.user_suspended", { userId, suspendedByAdmin: admin.email });
    return { ok: true, message: "Account suspended." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    logger.error("admin.user_suspend_failed", { userId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

export async function reinstateUserAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole("STAFF");

  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { ok: false, message: "Missing user." };

  try {
    await reinstateUser(userId);
    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
    logger.info("admin.user_reinstated", { userId });
    return { ok: true, message: "Account reinstated." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    logger.error("admin.user_reinstate_failed", { userId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}
