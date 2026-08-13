/**
 * Tax calculation — Ethiopian VAT.
 *
 * Standard VAT rate under Ethiopia's VAT Proclamation No. 285/2002 (as
 * amended) is 15%, applied to the sale of goods and services. That single
 * rate covers everything this storefront sells (apparel, footwear — no
 * zero-rated or VAT-exempt categories in this catalogue), so this module is
 * intentionally simple: one rate, applied to the taxable subtotal.
 *
 * WHAT THIS DOES NOT HANDLE, on purpose, and how to extend it correctly:
 *   - Zero-rated / exempt goods (a real requirement the moment the catalogue
 *     grows past apparel) — add a `taxCategory` to Variant and branch on it
 *     here; do not special-case product slugs inline.
 *   - Tax-inclusive pricing display (some Ethiopian retailers show
 *     VAT-inclusive shelf prices) — this module computes VAT as an ADDITION
 *     on top of the subtotal, matching how the checkout page and Order
 *     schema (subtotalSantim + taxSantim = ...) are structured. Switching to
 *     inclusive pricing is a pricing-model decision, not a one-line change.
 *   - Multi-jurisdiction tax (this is a single-country business) — if that
 *     ever changes, this is the one file that needs to grow a jurisdiction
 *     parameter; nothing else in checkout-service.ts should need to know.
 */

import { applyRate, type Santim } from "@santim/santimpay/money";

/** Ethiopia's standard VAT rate. */
export const ETHIOPIA_VAT_RATE = 0.15;

/**
 * VAT on a taxable subtotal, rounded half-up to the nearest santim — the
 * same rounding convention `@santim/santimpay/money`'s `applyRate` documents
 * as the Ethiopian accounting default, so this and every other rate
 * calculation in the codebase agree with each other and with finance.
 */
export function calculateTax(taxableSantim: Santim): Santim {
  return applyRate(taxableSantim, ETHIOPIA_VAT_RATE, "half-up");
}
