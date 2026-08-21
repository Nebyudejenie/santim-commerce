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
  requireApprovedSeller,
  SellerError,
  setSellerCommission,
  setSellerVacation,
  suspendSeller,
  updateSellerProfile,
} from "../sellers/seller-service.js";
import { recordAdminAction } from "../admin/audit-log-service.js";
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

export async function updateSellerProfileAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const user = await requireUser();
  const storeName = String(formData.get("storeName") ?? "");
  const description = String(formData.get("description") ?? "").trim() || undefined;
  const logoUrl = String(formData.get("logoUrl") ?? "").trim() || undefined;

  try {
    const seller = await requireApprovedSeller(user.id);
    await updateSellerProfile(seller.id, { storeName, description, logoUrl });
    revalidatePath("/sell");
    revalidatePath(`/sellers/${seller.slug}`);
    return { ok: true, message: "Store profile updated." };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.update_profile_action_failed", { userId: user.id, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
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
    await recordAdminAction({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "seller.approved",
      targetType: "Seller",
      targetId: sellerId,
    });
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
    await recordAdminAction({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "seller.rejected",
      targetType: "Seller",
      targetId: sellerId,
      metadata: { reason },
    });
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
    await recordAdminAction({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "seller.suspended",
      targetType: "Seller",
      targetId: sellerId,
    });
    return { ok: true, message: "Seller suspended." };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.suspend_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

export async function setSellerCommissionAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const admin = await requireRole("STAFF");
  const sellerId = String(formData.get("sellerId") ?? "");
  const commissionPercent = Number(formData.get("commissionPercent") ?? "");
  if (!sellerId) return { ok: false, message: "Missing seller id." };
  if (!Number.isFinite(commissionPercent)) return { ok: false, message: "Enter a valid commission percentage." };

  // The admin enters a human percentage (e.g. "10" for 10%); the service
  // layer's unit is basis points (1000 = 10.00%), matching Seller.commissionBps's
  // own doc comment and ledger-calculation.ts's existing convention.
  const commissionBps = Math.round(commissionPercent * 100);

  try {
    await setSellerCommission(sellerId, commissionBps, admin.id);
    revalidatePath("/admin/sellers");
    await recordAdminAction({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "seller.commission_changed",
      targetType: "Seller",
      targetId: sellerId,
      metadata: { commissionBps },
    });
    return { ok: true, message: `Commission set to ${(commissionBps / 100).toFixed(2)}%.` };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.commission_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

export async function setSellerVacationAction(
  _prev: SellerActionState,
  formData: FormData,
): Promise<SellerActionState> {
  const user = await requireUser();
  const onVacation = formData.get("onVacation") === "true";

  try {
    const seller = await requireApprovedSeller(user.id);
    await setSellerVacation(seller.id, onVacation);
    revalidatePath("/sell");
    revalidatePath("/sell/settings");
    revalidatePath(`/sellers/${seller.slug}`);
    return { ok: true, message: onVacation ? "Your store is now paused." : "Your store is live again." };
  } catch (error) {
    if (error instanceof SellerError) return { ok: false, message: error.message };
    logger.error("seller.vacation_action_failed", { userId: user.id, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

