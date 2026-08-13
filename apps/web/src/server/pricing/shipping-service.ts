/**
 * Shipping calculation — zone-based flat rates.
 *
 * WHY ZONES, NOT A CARRIER API OR A CITY DATABASE
 * ------------------------------------------------
 * There is no dominant integrated carrier API for Ethiopian last-mile
 * delivery the way there's a FedEx/USPS rate API to plug into elsewhere —
 * most Ethiopian e-commerce operators run their own courier relationships
 * and price shipping the way real-world Ethiopian retailers actually do:
 * one flat rate within Addis Ababa, a higher flat rate for everywhere else
 * ("up-country"). A full city/woreda-level rate table would be false
 * precision for a rate structure that's genuinely two-tier in practice.
 *
 * The customer picks their ZONE explicitly (see the `shippingZone` field on
 * the checkout form) rather than this code trying to infer it from a
 * free-text city string — "Addis Ababa", "addis", "A.A", "አዲስ አበባ" are all
 * the same zone to a human and none of them safely to a string-match.
 *
 * SWAPPING THIS FOR A REAL CARRIER LATER: this module's public surface
 * (`calculateShipping`) is the only thing checkout-service.ts calls. A real
 * carrier integration replaces this file's body with a rated-shipment API
 * call and keeps the same function signature — same pattern as
 * @santim/santimpay being the one file that knows the payment gateway exists.
 */

import { santim, type Santim } from "@santim/santimpay/money";

export type ShippingZone = "ADDIS_ABABA" | "REGIONAL";

export const SHIPPING_ZONES: ReadonlyArray<{ value: ShippingZone; label: string }> = [
  { value: "ADDIS_ABABA", label: "Addis Ababa" },
  { value: "REGIONAL", label: "Outside Addis Ababa" },
];

const BASE_RATE_SANTIM: Record<ShippingZone, Santim> = {
  ADDIS_ABABA: santim(15_000), // ETB 150.00
  REGIONAL: santim(35_000), // ETB 350.00
};

/** Orders at or above this subtotal ship free, in either zone. */
export const FREE_SHIPPING_THRESHOLD_SANTIM: Santim = santim(500_000); // ETB 5,000.00

export function isValidShippingZone(value: string): value is ShippingZone {
  return value === "ADDIS_ABABA" || value === "REGIONAL";
}

export function calculateShipping(zone: ShippingZone, subtotalSantim: Santim): Santim {
  if (subtotalSantim >= FREE_SHIPPING_THRESHOLD_SANTIM) {
    return santim(0);
  }
  return BASE_RATE_SANTIM[zone];
}
