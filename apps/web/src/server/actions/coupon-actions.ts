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
import { requireRole, requireUser } from "../auth/guard.js";
import { getSessionUser } from "../auth/session.js";
import { requireApprovedSeller, SellerError } from "../sellers/seller-service.js";
import {
  createCoupon,
  previewCouponDiscount,
  setCouponActive,
  setCouponActiveAsSeller,
  CouponError,
  type CartLineForCoupon,
  type CreateCouponInput,
} from "../promotions/coupon-service.js";
import { logger } from "../observability/logger.js";

export interface CouponPreviewState {
  readonly ok: boolean;
  readonly message?: string;
  readonly code?: string;
  readonly discountSantim?: number;
}

/** Best-effort parse of the checkout form's per-seller cart-line breakdown.
 * This preview is deliberately NOT authoritative (see module comment) — the
 * real, server-derived cart is what redeemCoupon() checks against at actual
 * checkout time, so a malformed or empty value here just means an honest
 * "0 items" preview, never a security concern. */
function parseCartLines(raw: string): CartLineForCoupon[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((l): l is { sellerId: string; lineTotalSantim: number } =>
        typeof l?.sellerId === "string" && typeof l?.lineTotalSantim === "number" && Number.isFinite(l.lineTotalSantim),
      )
      .map((l) => ({ sellerId: l.sellerId, lineTotalSantim: l.lineTotalSantim }));
  } catch {
    return [];
  }
}

export async function previewCouponAction(
  _prev: CouponPreviewState,
  formData: FormData,
): Promise<CouponPreviewState> {
  const code = String(formData.get("couponCode") ?? "").trim();
  const cartLines = parseCartLines(String(formData.get("cartLines") ?? "[]"));

  const user = await getSessionUser();
  if (!user) {
    return { ok: false, message: "Sign in to use a coupon code." };
  }
  if (!code) {
    return { ok: false, message: "Enter a coupon code." };
  }

  try {
    const preview = await previewCouponDiscount(code, user.id, cartLines);
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

/** Same pattern as listing-actions.ts's sellerIdOrState — resolves to a real
 * seller id, or an error state if the caller isn't a signed-in, approved
 * seller. A Server Action must check its own authorization, never rely on
 * the page that renders its trigger form. */
async function sellerIdOrState(): Promise<string | CouponAdminActionState> {
  const user = await requireUser();
  try {
    const seller = await requireApprovedSeller(user.id);
    return seller.id;
  } catch (error) {
    return { ok: false, message: error instanceof SellerError ? error.message : "Not authorized." };
  }
}

export async function createSellerCouponAction(
  _prev: CouponAdminActionState,
  formData: FormData,
): Promise<CouponAdminActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

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
    sellerId,
  };

  try {
    await createCoupon(input);
  } catch (error) {
    if (error instanceof CouponError) return { ok: false, message: error.message };
    logger.error("coupon.create_seller_action_failed", { sellerId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong creating that coupon. Please try again." };
  }

  revalidatePath("/sell/coupons");
  return { ok: true, message: "Coupon created." };
}

export async function toggleSellerCouponActiveAction(
  _prev: CouponAdminActionState,
  formData: FormData,
): Promise<CouponAdminActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const couponId = String(formData.get("couponId") ?? "");
  const active = formData.get("active") === "true";

  try {
    await setCouponActiveAsSeller(sellerId, couponId, active);
  } catch (error) {
    if (error instanceof CouponError) return { ok: false, message: error.message };
    logger.error("coupon.toggle_seller_action_failed", { sellerId, couponId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/sell/coupons");
  return { ok: true, message: active ? "Coupon reactivated." : "Coupon deactivated." };
}
