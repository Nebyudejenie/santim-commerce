"use client";

import { useActionState, useMemo, useState } from "react";
import { submitCheckout, type CheckoutFormState } from "@/server/actions/checkout-actions";
import { previewCouponAction, type CouponPreviewState } from "@/server/actions/coupon-actions";
import { calculateShipping, SHIPPING_ZONES, type ShippingZone } from "@/server/pricing/shipping-service";
import { calculateTax } from "@/server/pricing/tax-service";
import { santim } from "@santim/santimpay/money";
import { Money } from "./money";

const INITIAL_STATE: CheckoutFormState = { ok: false };
const INITIAL_COUPON_STATE: CouponPreviewState = { ok: false };

export interface SavedAddressOption {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly city: string;
  readonly subCity: string | null;
  readonly woreda: string | null;
  readonly streetLine: string | null;
  readonly landmark: string | null;
}

export interface CartLineForCouponPreview {
  readonly sellerId: string;
  readonly lineTotalSantim: number;
}

export function CheckoutForm({
  subtotalSantim,
  cartLines,
  isSignedIn,
  savedAddresses = [],
}: {
  subtotalSantim: number;
  /** Per-seller breakdown so a seller-issued coupon previews against only
   * that seller's own lines, never the whole cart — see coupon-service.ts's
   * own comment on why a seller must never end up funding a discount on
   * someone else's items. */
  cartLines: CartLineForCouponPreview[];
  isSignedIn: boolean;
  savedAddresses?: SavedAddressOption[];
}) {
  const [state, formAction, pending] = useActionState(submitCheckout, INITIAL_STATE);
  const [couponState, couponAction, couponPending] = useActionState(previewCouponAction, INITIAL_COUPON_STATE);
  const [acceptedPriceChanges, setAcceptedPriceChanges] = useState(false);
  const [zone, setZone] = useState<ShippingZone>("ADDIS_ABABA");
  // "new" means the manual-entry fields below; any other value is a saved
  // address's id. Defaults to the most recent saved address when one
  // exists — the common case is reusing where you last shipped to.
  const [selectedAddressId, setSelectedAddressId] = useState<string>(savedAddresses[0]?.id ?? "new");

  const selectedAddress = savedAddresses.find((a) => a.id === selectedAddressId);

  const needsPriceConfirmation = Boolean(state.priceChangedVariantIds?.length) && !acceptedPriceChanges;

  // An applied coupon is only "live" once the preview action returns ok for
  // the code currently in the input — editing the code after a successful
  // preview clears the applied discount until it's re-verified.
  const appliedDiscountSantim = couponState.ok ? (couponState.discountSantim ?? 0) : 0;
  const appliedCouponCode = couponState.ok ? (couponState.code ?? "") : "";

  // Computed with the SAME pricing modules checkout-service.ts calls
  // server-side (see that file's import of these two), applying the
  // discount the exact same way checkout-service.ts's placeOrder does: VAT
  // on the post-discount subtotal, shipping-threshold on the pre-discount
  // one. What the customer sees here is what gets charged.
  const { shippingSantim, taxSantim, totalSantim } = useMemo(() => {
    const subtotal = santim(subtotalSantim);
    const shipping = calculateShipping(zone, subtotal);
    const taxable = Math.max(0, subtotal - appliedDiscountSantim);
    const tax = calculateTax(santim(taxable));
    return { shippingSantim: shipping, taxSantim: tax, totalSantim: taxable + shipping + tax };
  }, [zone, subtotalSantim, appliedDiscountSantim]);

  return (
    <>
      {/* Lives outside the main form — HTML forbids a nested <form>. The
          coupon inputs/button below reference it via the `form` attribute,
          which is exactly what that attribute is for. */}
      <form id="coupon-preview-form" action={couponAction} />

      <form action={formAction}>
      <input type="hidden" name="acceptPriceChanges" value={acceptedPriceChanges ? "true" : "false"} />
      <input type="hidden" name="appliedCouponCode" value={appliedCouponCode} />

      {isSignedIn && (
        <div className="form-field">
          <label htmlFor="couponCode">Coupon code</label>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <input
              id="couponCode"
              name="couponCode"
              form="coupon-preview-form"
              type="text"
              placeholder="e.g. WELCOME10"
              style={{ flex: 1 }}
            />
            <input type="hidden" form="coupon-preview-form" name="cartLines" value={JSON.stringify(cartLines)} />
            <button
              type="submit"
              form="coupon-preview-form"
              className="btn btn--secondary"
              disabled={couponPending}
            >
              {couponPending ? "…" : "Apply"}
            </button>
          </div>
          {couponState.message && (
            <p className={couponState.ok ? "form-hint" : "form-hint form-hint--error"}>{couponState.message}</p>
          )}
          {couponState.ok && (
            <p className="form-hint">
              Applied {couponState.code}: <Money santim={appliedDiscountSantim} /> off
            </p>
          )}
        </div>
      )}

      {state.error && <p className="alert alert--error">{state.error}</p>}

      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
      </div>

      {isSignedIn && savedAddresses.length > 0 && (
        <div className="form-field">
          <label htmlFor="savedAddress">Deliver to</label>
          <select
            id="savedAddress"
            value={selectedAddressId}
            onChange={(e) => setSelectedAddressId(e.target.value)}
          >
            {savedAddresses.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName} — {[a.streetLine, a.city].filter(Boolean).join(", ")}
              </option>
            ))}
            <option value="new">Use a new address</option>
          </select>
        </div>
      )}

      {/* Remounts with fresh defaultValues whenever a different saved
          address is picked — uncontrolled inputs, so this is the standard,
          low-risk way to "prefill" them without turning the whole payment
          form into controlled state. */}
      <div key={selectedAddressId}>
        <div className="form-row form-row--2">
          <div className="form-field">
            <label htmlFor="fullName">Full name</label>
            <input id="fullName" name="fullName" type="text" autoComplete="name" required defaultValue={selectedAddress?.fullName} />
          </div>
          <div className="form-field">
            <label htmlFor="phone">Phone</label>
            <input id="phone" name="phone" type="tel" autoComplete="tel" required placeholder="0912345678" defaultValue={selectedAddress?.phone} />
            <p className="form-hint">Used for delivery updates and to pre-fill your payment page.</p>
          </div>
        </div>

        <div className="form-row form-row--2">
          <div className="form-field">
            <label htmlFor="city">City</label>
            <input id="city" name="city" type="text" autoComplete="address-level2" required defaultValue={selectedAddress?.city ?? "Addis Ababa"} />
          </div>
          <div className="form-field">
            <label htmlFor="streetLine">Street / area</label>
            <input id="streetLine" name="streetLine" type="text" autoComplete="street-address" required defaultValue={selectedAddress?.streetLine ?? ""} />
          </div>
        </div>

        <div className="form-row form-row--2">
          <div className="form-field">
            <label htmlFor="subCity">Sub-city (optional)</label>
            <input id="subCity" name="subCity" type="text" defaultValue={selectedAddress?.subCity ?? ""} />
          </div>
          <div className="form-field">
            <label htmlFor="landmark">Landmark (optional)</label>
            <input id="landmark" name="landmark" type="text" placeholder="e.g. near Bole Medhanealem" defaultValue={selectedAddress?.landmark ?? ""} />
          </div>
        </div>

        {isSignedIn && selectedAddressId === "new" && (
          <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-4)" }}>
            <input type="checkbox" name="saveAddress" value="true" />
            Save this address for next time
          </label>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="shippingZone">Delivery zone</label>
        <select
          id="shippingZone"
          name="shippingZone"
          value={zone}
          onChange={(e) => setZone(e.target.value as ShippingZone)}
          required
        >
          {SHIPPING_ZONES.map((z) => (
            <option key={z.value} value={z.value}>{z.label}</option>
          ))}
        </select>
        <p className="form-hint">Shipping cost depends on zone — see the total update below.</p>
      </div>

      <div className="summary-card" style={{ marginBottom: "var(--space-5)" }}>
        <div className="summary-row">
          <span>Subtotal</span>
          <Money santim={subtotalSantim} />
        </div>
        {appliedDiscountSantim > 0 && (
          <div className="summary-row">
            <span>Discount ({appliedCouponCode})</span>
            <span>-<Money santim={appliedDiscountSantim} /></span>
          </div>
        )}
        <div className="summary-row">
          <span>Shipping</span>
          {shippingSantim === 0 ? "Free" : <Money santim={shippingSantim} />}
        </div>
        <div className="summary-row">
          <span>VAT (15%)</span>
          <Money santim={taxSantim} />
        </div>
        <div className="summary-row summary-row--total">
          <span>Total</span>
          <Money santim={totalSantim} />
        </div>
      </div>

      {state.priceChangedVariantIds && state.priceChangedVariantIds.length > 0 && (
        <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <input
            type="checkbox"
            checked={acceptedPriceChanges}
            onChange={(e) => setAcceptedPriceChanges(e.target.checked)}
          />
          I&apos;ve reviewed the updated prices and want to continue
        </label>
      )}

      <button
        type="submit"
        className="btn btn--primary btn--full btn--lg"
        disabled={pending || needsPriceConfirmation}
      >
        {pending ? "Redirecting to payment…" : "Continue to payment"}
      </button>

      <p className="payment-methods" aria-hidden="true">
        <span className="payment-chip">Telebirr</span>
        <span className="payment-chip">CBE Birr</span>
        <span className="payment-chip">Amole</span>
        <span className="payment-chip">HelloCash</span>
      </p>
      </form>
    </>
  );
}
