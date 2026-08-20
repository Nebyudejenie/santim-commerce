"use client";

import { useActionState, useMemo, useState } from "react";
import { submitCheckout, type CheckoutFormState } from "@/server/actions/checkout-actions";
import { calculateShipping, SHIPPING_ZONES, type ShippingZone } from "@/server/pricing/shipping-service";
import { calculateTax } from "@/server/pricing/tax-service";
import { santim } from "@santim/santimpay/money";
import { Money } from "./money";

const INITIAL_STATE: CheckoutFormState = { ok: false };

export function CheckoutForm({ subtotalSantim }: { subtotalSantim: number }) {
  const [state, formAction, pending] = useActionState(submitCheckout, INITIAL_STATE);
  const [acceptedPriceChanges, setAcceptedPriceChanges] = useState(false);
  const [zone, setZone] = useState<ShippingZone>("ADDIS_ABABA");

  const needsPriceConfirmation = Boolean(state.priceChangedVariantIds?.length) && !acceptedPriceChanges;

  // Computed with the SAME pricing modules checkout-service.ts calls
  // server-side (see that file's import of these two) — not a
  // reimplemented approximation. What the customer sees here is what gets
  // charged, because it's the identical function, not a copy of its logic.
  const { shippingSantim, taxSantim, totalSantim } = useMemo(() => {
    const subtotal = santim(subtotalSantim);
    const shipping = calculateShipping(zone, subtotal);
    const tax = calculateTax(subtotal);
    return { shippingSantim: shipping, taxSantim: tax, totalSantim: subtotal + shipping + tax };
  }, [zone, subtotalSantim]);

  return (
    <form action={formAction}>
      <input type="hidden" name="acceptPriceChanges" value={acceptedPriceChanges ? "true" : "false"} />

      {state.error && <p className="alert alert--error">{state.error}</p>}

      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="fullName">Full name</label>
          <input id="fullName" name="fullName" type="text" autoComplete="name" required />
        </div>
        <div className="form-field">
          <label htmlFor="phone">Phone</label>
          <input id="phone" name="phone" type="tel" autoComplete="tel" required placeholder="0912345678" />
          <p className="form-hint">Used for delivery updates and to pre-fill your payment page.</p>
        </div>
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="city">City</label>
          <input id="city" name="city" type="text" autoComplete="address-level2" required defaultValue="Addis Ababa" />
        </div>
        <div className="form-field">
          <label htmlFor="streetLine">Street / area</label>
          <input id="streetLine" name="streetLine" type="text" autoComplete="street-address" required />
        </div>
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
  );
}
