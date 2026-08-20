"use server";

/**
 * Coupon mutations — checks its own authorization, same in-action-auth
 * discipline as every other action added this session.
 *
 * `previewCouponAction` is deliberately NOT a hard authorization boundary:
 * it's a read-only preview (see coupon-service.ts's `previewCouponDiscount`)
 * called from the checkout form before payment. The actual redemption, and
 * its guest-checkout guard, live in checkout-service.ts's `placeOrder` —
 * this action just gives the customer an honest number to look at first.
 */

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard.js";
import { getSessionUser } from "../auth/session.js";
import {
  createCoupon,
  previewCouponDiscount,
  setCouponActive,
  CouponError,
  type CreateCouponInput,
} from "../promotions/coupon-service.js";
import { logger } from "../observability/logger.js";

export interface CouponPreviewState {
  readonly ok: boolean;
  readonly message?: string;
  readonly code?: string;
  readonly discountSantim?: number;
}

export async function previewCouponAction(
  _prev: CouponPreviewState,
  formData: FormData,
): Promise<CouponPreviewState> {
  const code = String(formData.get("couponCode") ?? "").trim();
  const subtotalSantim = Number(formData.get("subtotalSantim") ?? 0);

  const user = await getSessionUser();
  if (!user) {
    return { ok: false, message: "Sign in to use a coupon code." };
  }
  if (!code) {
    return { ok: false, message: "Enter a coupon code." };
  }

  try {
    const preview = await previewCouponDiscount(code, user.id, subtotalSantim);
    return { ok: true, code: code.toUpperCase(), discountSantim: preview.discountSantim };
  } catch (error) {
    if (error instanceof CouponError) return { ok: false, message: error.message };
    logger.error("coupon.preview_action_failed", { code, error: (error as Error).message });
    return { ok: false, message: "Something went wrong checking that code. Please try again." };
  }
}

export interface CouponAdminActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function createCouponAction(
  _prev: CouponAdminActionState,
  formData: FormData,
): Promise<CouponAdminActionState> {
  await requireRole("STAFF");

  const discountType = String(formData.get("discountType") ?? "");
  if (discountType !== "PERCENTAGE" && discountType !== "FIXED_AMOUNT") {
    return { ok: false, message: "Choose a discount type." };
  }

  const validFromRaw = String(formData.get("validFrom") ?? "").trim();
  const validUntilRaw = String(formData.get("validUntil") ?? "").trim();
  const redemptionsRaw = String(formData.get("redemptionsRemaining") ?? "").trim();

  const input: CreateCouponInput = {
    code: String(formData.get("code") ?? ""),
    description: String(formData.get("description") ?? "") || undefined,
    discountType,
    discountValueRaw: String(formData.get("discountValue") ?? ""),
    maxDiscountBirr: String(formData.get("maxDiscountBirr") ?? ""),
    minSubtotalBirr: String(formData.get("minSubtotalBirr") ?? ""),
    redemptionsRemaining: redemptionsRaw ? Number(redemptionsRaw) : null,
    validFrom: validFromRaw ? new Date(validFromRaw) : null,
    validUntil: validUntilRaw ? new Date(validUntilRaw) : null,
  };

  try {
    await createCoupon(input);
  } catch (error) {
    if (error instanceof CouponError) return { ok: false, message: error.message };
    logger.error("coupon.create_action_failed", { error: (error as Error).message });
    return { ok: false, message: "Something went wrong creating that coupon. Please try again." };
  }

  revalidatePath("/admin/coupons");
  return { ok: true, message: "Coupon created." };
}

export async function toggleCouponActiveAction(
  _prev: CouponAdminActionState,
  formData: FormData,
): Promise<CouponAdminActionState> {
  await requireRole("STAFF");

  const couponId = String(formData.get("couponId") ?? "");
  const active = formData.get("active") === "true";

  try {
    await setCouponActive(couponId, active);
  } catch (error) {
    logger.error("coupon.toggle_action_failed", { couponId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/admin/coupons");
  return { ok: true, message: active ? "Coupon reactivated." : "Coupon deactivated." };
}
