import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCartDetail } from "@/server/cart/get-cart-detail";
import { CheckoutForm } from "@/components/checkout-form";
import { Money } from "@/components/money";
import { getSessionUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  const cart = await getCartDetail();
  if (!cart) redirect("/cart");
  const sessionUser = await getSessionUser();

  return (
    <div className="container checkout-page">
      <div>
        <div className="section-head">
          <h2>Checkout</h2>
        </div>
        {/* subtotalSantim drives the live shipping/VAT/total breakdown the
            form renders itself, using the SAME pricing modules
            checkout-service.ts calls server-side — see that component. */}
        <CheckoutForm subtotalSantim={cart.subtotalSantim} isSignedIn={Boolean(sessionUser)} />
      </div>

      <aside className="summary-card">
        <p style={{ fontWeight: 600, marginBottom: "var(--space-4)" }}>In your bag</p>
        {cart.lines.map((line) => (
          <div key={line.variantId} className="summary-row">
            <span>
              {line.productTitle} · {line.variantTitle} × {line.quantity}
            </span>
            <Money santim={line.lineTotalSantim} />
          </div>
        ))}
        <div className="summary-row summary-row--total">
          <span>Subtotal</span>
          <Money santim={cart.subtotalSantim} />
        </div>
        <p className="form-hint" style={{ marginTop: "var(--space-3)" }}>
          Shipping and VAT are added based on your delivery zone — see the full total in the form.
        </p>
      </aside>
    </div>
  );
}
