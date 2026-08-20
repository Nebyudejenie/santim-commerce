/**
 * Pure discount math — zero imports, so it can be unit-tested under plain
 * `node --experimental-strip-types` (see seller-state-machine.ts for why
 * that constraint exists). Eligibility (active, date window, minimum
 * subtotal, redemption limits) is coupon-service.ts's job; this module only
 * turns a validated coupon's rules into a santim amount.
 */

export type CouponDiscountType = "PERCENTAGE" | "FIXED_AMOUNT";

export interface CouponDiscountRules {
  readonly discountType: CouponDiscountType;
  /** PERCENTAGE: whole points, e.g. 10 = 10%. FIXED_AMOUNT: santim. */
  readonly discountValue: number;
  /** Caps a PERCENTAGE discount's absolute santim value. Ignored for FIXED_AMOUNT. */
  readonly maxDiscountSantim: number | null;
}

/**
 * Never returns more than `subtotalSantim` (a coupon cannot make the order
 * go negative) and never negative (a malformed/negative discountValue must
 * not turn into a surcharge).
 */
export function computeCouponDiscountSantim(subtotalSantim: number, rules: CouponDiscountRules): number {
  if (!Number.isInteger(subtotalSantim) || subtotalSantim < 0) {
    throw new RangeError(`subtotalSantim must be a non-negative integer, got ${subtotalSantim}`);
  }
  if (!Number.isInteger(rules.discountValue) || rules.discountValue < 0) {
    throw new RangeError(`discountValue must be a non-negative integer, got ${rules.discountValue}`);
  }

  const raw =
    rules.discountType === "PERCENTAGE"
      ? Math.round((subtotalSantim * rules.discountValue) / 100)
      : rules.discountValue;

  const capped = rules.maxDiscountSantim != null ? Math.min(raw, rules.maxDiscountSantim) : raw;

  return Math.max(0, Math.min(capped, subtotalSantim));
}
