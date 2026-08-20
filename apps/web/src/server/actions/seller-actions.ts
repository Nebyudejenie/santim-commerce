"use server";

/**
 * Seller lifecycle mutations. Every action checks its own authorization —
 * see admin-actions.ts's module comment on why a Server Action must never
 * rely on the page/layout that happens to render its triggering form.
 * `applyToBecomeSellerAction` uses `requireUser` (any logged-in customer);
 * the review actions use `requireRole("STAFF")`.
 */

import { revalidatePath } from "next/cache";
import { requireRole, requireUser } from "../auth/guard.js";
import {
  applyToBecomeSeller,
  approveSeller,
  rejectSeller,
  SellerError,
  suspendSeller,
} from "../sellers/seller-service.js";
import { logger } from "../observability/logger.js";

export interface SellerActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function applyToBecomeSellerAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const user = await requireUser();
  const storeName = String(formData.get("storeName") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || undefined;

  try {
    const seller = await applyToBecomeSeller({ userId: user.id, storeName, description });
    revalidatePath("/sell");
    return { ok: true, message: `Application submitted for "${seller.storeName}" — awaiting review.` };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.apply_action_failed", { userId: user.id, error: (error as Error).message });
    return { ok: false, message: "Something went wrong submitting your application. Please try again." };
  }
}

export async function approveSellerAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const admin = await requireRole("STAFF");
  const sellerId = String(formData.get("sellerId") ?? "");
  if (!sellerId) return { ok: false, message: "Missing seller id." };

  try {
    await approveSeller(sellerId, admin.id);
    revalidatePath("/admin/sellers");
    return { ok: true, message: "Seller approved." };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.approve_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

export async function rejectSellerAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const admin = await requireRole("STAFF");
  const sellerId = String(formData.get("sellerId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (!sellerId) return { ok: false, message: "Missing seller id." };

  try {
    await rejectSeller(sellerId, admin.id, reason);
    revalidatePath("/admin/sellers");
    return { ok: true, message: "Seller application rejected." };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.reject_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

export async function suspendSellerAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const admin = await requireRole("STAFF");
  const sellerId = String(formData.get("sellerId") ?? "");
  if (!sellerId) return { ok: false, message: "Missing seller id." };

  try {
    await suspendSeller(sellerId, admin.id);
    revalidatePath("/admin/sellers");
    return { ok: true, message: "Seller suspended." };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.suspend_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

