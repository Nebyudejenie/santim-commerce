"use server";

/**
 * The checkout Server Action.
 *
 * On success this THROWS via `redirect()` — that is Next.js's normal
 * mechanism, not an error path, and it works to an external origin (the
 * SantimPay hosted payment page) exactly as it does to an internal route.
 * On any handled failure it returns a state object instead, which
 * `useActionState` on the client renders inline without a full page
 * navigation — a price change or a validation typo shouldn't cost the
 * customer their place in the flow.
 */

import { redirect } from "next/navigation";
import { readCartToken } from "../cart/cart-cookie.js";
import {
  CheckoutError,
  EmptyCartError,
  PriceChangedError,
  placeOrderAndStartPayment,
} from "../checkout/checkout-service.js";
import { logger } from "../observability/logger.js";
import { checkoutFailuresTotal } from "../observability/metrics.js";
import { getSessionUser } from "../auth/session.js";
import { isValidShippingZone } from "../pricing/shipping-service.js";
import { saveAddressFromCheckout } from "../addresses/address-service.js";

export interface CheckoutFormState {
  readonly ok: boolean;
  readonly error?: string;
  readonly priceChangedVariantIds?: string[];
}

export async function submitCheckout(
  _prev: CheckoutFormState,
  formData: FormData,
): Promise<CheckoutFormState> {
  const cartToken = await readCartToken();
  if (!cartToken) {
    return { ok: false, error: "Your bag is empty." };
  }

  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const streetLine = String(formData.get("streetLine") ?? "").trim();
  const subCity = String(formData.get("subCity") ?? "").trim() || undefined;
  const landmark = String(formData.get("landmark") ?? "").trim() || undefined;
  const shippingZone = String(formData.get("shippingZone") ?? "");
  const acceptPriceChanges = formData.get("acceptPriceChanges") === "true";
  const couponCode = String(formData.get("appliedCouponCode") ?? "").trim() || undefined;
  const shouldSaveAddress = formData.get("saveAddress") === "true";

  if (!email || !email.includes("@")) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!fullName) {
    return { ok: false, error: "Enter the name for delivery." };
  }
  if (!city || !streetLine) {
    return { ok: false, error: "Enter a delivery address." };
  }
  if (!isValidShippingZone(shippingZone)) {
    return { ok: false, error: "Choose a delivery zone." };
  }

  // A logged-in customer's orders are associated with their account
  // automatically; a guest checkout leaves userId null — see
  // checkout-service.ts's PlaceOrderInput, which treats both as first-class.
  const sessionUser = await getSessionUser();

  let paymentUrl: string;
  try {
    const result = await placeOrderAndStartPayment({
      cartToken,
      email,
      phone,
      userId: sessionUser?.id ?? null,
      shippingZone,
      shippingAddress: { fullName, phone, city, streetLine, subCity, landmark, shippingZone },
      acceptPriceChanges,
      couponCode,
    });
    paymentUrl = result.paymentUrl;

    logger.info("checkout.redirecting_to_gateway", { orderNumber: result.orderNumber });

    // Best-effort, deliberately outside any transaction: saving a
    // convenience address must never be able to fail or slow down a real
    // payment redirect. A failure here is logged and swallowed, not
    // surfaced to the customer — see address-service.ts's own comment.
    if (sessionUser && shouldSaveAddress) {
      try {
        await saveAddressFromCheckout(sessionUser.id, { fullName, phone, city, streetLine, subCity, landmark });
      } catch (error) {
        logger.error("checkout.save_address_failed", { userId: sessionUser.id, error: (error as Error).message });
      }
    }
  } catch (error) {
    if (error instanceof PriceChangedError) {
      checkoutFailuresTotal.inc({ reason: "price_changed" });
      return {
        ok: false,
        error: "Some prices changed since you added these items. Review your bag and confirm to continue.",
        priceChangedVariantIds: error.changedVariantIds,
      };
    }
    if (error instanceof EmptyCartError) {
      checkoutFailuresTotal.inc({ reason: "empty_cart" });
      return { ok: false, error: "Your bag is empty." };
    }
    if (error instanceof CheckoutError) {
      checkoutFailuresTotal.inc({ reason: "checkout_error" });
      return { ok: false, error: error.message };
    }
    logger.error("checkout.failed", { error: (error as Error).message });
    checkoutFailuresTotal.inc({ reason: "unknown" });
    return { ok: false, error: "Something went wrong starting your payment. Please try again." };
  }

  // Outside the try/catch: redirect() throws by design, and catching it here
  // would misreport a successful redirect as a checkout failure.
  redirect(paymentUrl);
}
