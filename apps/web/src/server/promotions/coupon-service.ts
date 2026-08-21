/**
 * Coupons: admin-issued (platform-wide) or seller-issued (scoped to that
 * seller's own lines), one redemption per customer.
 *
 * A seller-issued coupon's discount base is that seller's OWN subtotal
 * within the cart — never the whole cart. A 20%-off coupon from Seller A
 * must never discount Seller B's items sitting in the same cart; Seller A
 * is the one funding this discount (see settlement-service.ts's
 * COUPON_DISCOUNT entry), and funding a stranger's items would be a real
 * accounting bug, not a rounding nit. `relevantSubtotal` below is the one
 * function that decides which subtotal — whole-cart or seller-scoped —
 * governs both the minimum-spend check and the discount calculation.
 *
 * `redeemCoupon` is meant to be called from INSIDE checkout-service.ts's
 * order-creation transaction, before `totalSantim` is computed — not as a
 * standalone call. It does two atomic things in the same transaction as the
 * order it belongs to:
 *
 *   1. Conditionally decrements `redemptionsRemaining` (if the coupon has a
 *      cap) via `updateMany({ where: { redemptionsRemaining: { gt: 0 } } })`
 *      — the exact same "atomic conditional UPDATE, check the row count"
 *      pattern reservation.ts uses to prevent overselling inventory. Two
 *      concurrent checkouts racing the last redemption of a limited coupon
 *      can never both win.
 *   2. Leaves the actual `CouponRedemption` row for the caller to create
 *      AFTER the order exists (it needs a real `orderId`) — its
 *      `@@unique([couponId, userId])` constraint is the hard backstop
 *      against the same customer redeeming the same coupon twice from two
 *      concurrent requests, even though we also check for an existing
 *      redemption up front for a friendlier error message.
 *
 * If anything after this point in the transaction throws — including the
 * later `CouponRedemption.create` hitting that unique constraint — the
 * WHOLE transaction rolls back, `redemptionsRemaining` included. A failed
 * checkout must never permanently burn a coupon use.
 */

import { birr, MoneyError } from "@santim/santimpay";
import { prisma, type Tx } from "../db.js";
import { computeCouponDiscountSantim } from "./coupon-calculation.js";

/** Same string-in, santim-out boundary parsing as listing-service.ts's own
 * `parseBirr` — money is never trusted as a pre-converted number crossing
 * the action/service boundary. */
function parseBirrField(raw: string, field: string): number {
  const value = Number(raw);
  try {
    return birr(value);
  } catch (error) {
    throw new CouponError(error instanceof MoneyError ? `${field}: ${error.message}` : `${field} is invalid.`);
  }
}

export class CouponError extends Error {
  override name = "CouponError";
}

export interface RedeemedCoupon {
  readonly couponId: string;
  readonly discountSantim: number;
}

export interface CartLineForCoupon {
  readonly sellerId: string;
  readonly lineTotalSantim: number;
}

/** Whole-cart subtotal for an admin coupon; that one seller's own lines only
 * for a seller-scoped coupon — see this module's own comment on why a
 * seller must never end up funding a discount on someone else's items. */
function relevantSubtotal(sellerId: string | null, cartLines: readonly CartLineForCoupon[]): number {
  const lines = sellerId ? cartLines.filter((l) => l.sellerId === sellerId) : cartLines;
  return lines.reduce((sum, l) => sum + l.lineTotalSantim, 0);
}

/** Shared, read-only validation between the real redemption path and the
 * checkout UI's preview path — see `previewCouponDiscount` below. */
async function findValidCoupon(db: Tx, code: string, userId: string, cartLines: readonly CartLineForCoupon[]) {
  const normalizedCode = code.trim().toUpperCase();
  if (normalizedCode.length === 0) {
    throw new CouponError("Enter a coupon code.");
  }

  const coupon = await db.coupon.findUnique({ where: { code: normalizedCode } });
  if (!coupon) {
    throw new CouponError("This coupon code doesn't exist.");
  }
  if (!coupon.active) {
    throw new CouponError("This coupon is no longer active.");
  }

  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) {
    throw new CouponError("This coupon isn't valid yet.");
  }
  if (coupon.validUntil && now > coupon.validUntil) {
    throw new CouponError("This coupon has expired.");
  }

  const subtotalSantim = relevantSubtotal(coupon.sellerId, cartLines);
  if (coupon.sellerId && subtotalSantim === 0) {
    throw new CouponError("This coupon only applies to items from a specific seller that isn't in your cart.");
  }
  if (subtotalSantim < coupon.minSubtotalSantim) {
    const minBirr = (coupon.minSubtotalSantim / 100).toFixed(2);
    const scope = coupon.sellerId ? "eligible items" : "subtotal";
    throw new CouponError(`This coupon requires a ${scope} of at least ${minBirr} ETB.`);
  }

  const existingRedemption = await db.couponRedemption.findUnique({
    where: { couponId_userId: { couponId: coupon.id, userId } },
  });
  if (existingRedemption) {
    throw new CouponError("You've already used this coupon.");
  }

  return { coupon, subtotalSantim };
}

/**
 * Validates the coupon against `now` and the cart, and — if it has a total
 * redemption cap — atomically reserves one redemption. Does NOT create the
 * `CouponRedemption` row (see module comment for why).
 */
export async function redeemCoupon(
  tx: Tx,
  code: string,
  userId: string,
  cartLines: readonly CartLineForCoupon[],
): Promise<RedeemedCoupon> {
  const { coupon, subtotalSantim } = await findValidCoupon(tx, code, userId, cartLines);

  if (coupon.redemptionsRemaining != null) {
    const result = await tx.coupon.updateMany({
      where: { id: coupon.id, redemptionsRemaining: { gt: 0 } },
      data: { redemptionsRemaining: { decrement: 1 } },
    });
    if (result.count !== 1) {
      throw new CouponError("This coupon has reached its redemption limit.");
    }
  }

  const discountSantim = computeCouponDiscountSantim(subtotalSantim, {
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    maxDiscountSantim: coupon.maxDiscountSantim,
  });

  return { couponId: coupon.id, discountSantim };
}

export interface CouponPreview {
  readonly discountSantim: number;
  readonly description: string | null;
}

/**
 * Read-only preview for the checkout form — does NOT reserve a redemption,
 * so a coupon that previews cleanly can still legitimately be rejected at
 * real checkout (e.g. someone else took the last redemption in between).
 * That's not a bug: it's the same optimistic-preview-then-authoritative-
 * recheck pattern checkout-service.ts already applies to price and
 * seller-status changes between add-to-cart and checkout.
 */
export async function previewCouponDiscount(
  code: string,
  userId: string,
  cartLines: readonly CartLineForCoupon[],
): Promise<CouponPreview> {
  const { coupon, subtotalSantim } = await findValidCoupon(prisma, code, userId, cartLines);
  const discountSantim = computeCouponDiscountSantim(subtotalSantim, {
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    maxDiscountSantim: coupon.maxDiscountSantim,
  });
  return { discountSantim, description: coupon.description };
}

export interface CreateCouponInput {
  readonly code: string;
  readonly description?: string;
  readonly discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  /** Whole percentage points ("10") if PERCENTAGE; ETB birr ("50.00") if FIXED_AMOUNT. */
  readonly discountValueRaw: string;
  /** ETB birr, e.g. "100.00". Empty/undefined = uncapped. */
  readonly maxDiscountBirr?: string;
  /** ETB birr, e.g. "500.00". Empty/undefined = no minimum. */
  readonly minSubtotalBirr?: string;
  readonly redemptionsRemaining?: number | null;
  readonly validFrom?: Date | null;
  readonly validUntil?: Date | null;
  /** Undefined/null = admin/platform-wide. Set = scoped to that seller's own lines. */
  readonly sellerId?: string | null;
}

export async function createCoupon(input: CreateCouponInput) {
  const normalizedCode = input.code.trim().toUpperCase();
  if (normalizedCode.length < 3) {
    throw new CouponError("Coupon code must be at least 3 characters.");
  }
  if (input.validFrom && input.validUntil && input.validFrom >= input.validUntil) {
    throw new CouponError("The start date must be before the end date.");
  }

  let discountValue: number;
  if (input.discountType === "PERCENTAGE") {
    discountValue = Number(input.discountValueRaw);
    if (!Number.isInteger(discountValue) || discountValue <= 0 || discountValue > 100) {
      throw new CouponError("Percentage discount must be a whole number between 1 and 100.");
    }
  } else {
    discountValue = parseBirrField(input.discountValueRaw, "Discount amount");
    if (discountValue <= 0) {
      throw new CouponError("Discount amount must be greater than zero.");
    }
  }

  const maxDiscountSantim =
    input.maxDiscountBirr && input.maxDiscountBirr.trim()
      ? parseBirrField(input.maxDiscountBirr, "Maximum discount")
      : null;
  const minSubtotalSantim =
    input.minSubtotalBirr && input.minSubtotalBirr.trim()
      ? parseBirrField(input.minSubtotalBirr, "Minimum subtotal")
      : 0;

  try {
    return await prisma.coupon.create({
      data: {
        code: normalizedCode,
        description: input.description,
        sellerId: input.sellerId ?? null,
        discountType: input.discountType,
        discountValue,
        maxDiscountSantim,
        minSubtotalSantim,
        redemptionsRemaining: input.redemptionsRemaining ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CouponError(`Coupon code "${normalizedCode}" already exists.`);
    }
    throw error;
  }
}

/** Admin-only — any coupon, admin- or seller-issued. */
export async function setCouponActive(couponId: string, active: boolean): Promise<void> {
  await prisma.coupon.update({ where: { id: couponId }, data: { active } });
}

/**
 * A seller may only toggle their OWN coupons — ownership via the WHERE
 * clause itself, not a separate read-then-check. A cross-seller attempt
 * (or a bare admin coupon, sellerId null) simply matches zero rows, the
 * same "indistinguishable from not existing" outcome every other
 * ownership-scoped mutation in this codebase produces.
 */
export async function setCouponActiveAsSeller(sellerId: string, couponId: string, active: boolean): Promise<void> {
  const result = await prisma.coupon.updateMany({ where: { id: couponId, sellerId }, data: { active } });
  if (result.count !== 1) {
    throw new CouponError("Coupon not found.");
  }
}

export async function listCoupons() {
  return prisma.coupon.findMany({
    where: { sellerId: null },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { redemptions: true } } },
  });
}

export async function listCouponsForSeller(sellerId: string) {
  return prisma.coupon.findMany({
    where: { sellerId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { redemptions: true } } },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
