import Link from "next/link";
import type { Metadata } from "next";
import { getCartDetail } from "@/server/cart/get-cart-detail";
import { decrementLineAction, incrementLineAction, removeLineAction } from "@/server/actions/cart-actions";
import { Money } from "@/components/money";
import { ProductImage } from "@/components/product-image";

export const metadata: Metadata = { title: "Your bag" };

export default async function CartPage() {
  const cart = await getCartDetail();

  if (!cart) {
    return (
      <div className="container">
        <div className="empty-state">
          <h2>Your bag is empty</h2>
          <p style={{ marginBottom: "var(--space-6)" }}>Find something you&apos;ll wear on repeat.</p>
          <Link href="/shop" className="btn btn--primary">Continue shopping</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container cart-page">
      <div>
        <div className="section-head">
          <h2>Your bag</h2>
        </div>

        {cart.hasPriceChanges && (
          <p className="alert alert--error">
            One or more prices changed since you added these items. Review before checkout.
          </p>
        )}
        {cart.hasStockIssues && (
          <p className="alert alert--error">
            Some items exceed what&apos;s currently in stock. Reduce quantity to check out.
          </p>
        )}

        <ul>
          {cart.lines.map((line) => (
            <li key={line.variantId} className="cart-line">
              <div className="cart-line__image">
                {line.image && <ProductImage src={line.image} alt={line.productTitle} width={88} height={110} />}
              </div>

              <div>
                <p className="cart-line__title">
                  <Link href={`/products/${line.productSlug}`}>{line.productTitle}</Link>
                </p>
                <p className="cart-line__variant">
                  {line.variantTitle}
                  {line.priceChanged && " · price updated"}
                  {line.exceedsAvailable && ` · only ${line.available} available`}
                </p>

                <div className="qty-stepper">
                  <form action={decrementLineAction}>
                    <input type="hidden" name="variantId" value={line.variantId} />
                    <button type="submit" aria-label={`Decrease quantity of ${line.productTitle}`}>–</button>
                  </form>
                  <span aria-live="polite">{line.quantity}</span>
                  <form action={incrementLineAction}>
                    <input type="hidden" name="variantId" value={line.variantId} />
                    <button type="submit" aria-label={`Increase quantity of ${line.productTitle}`}>+</button>
                  </form>
                </div>

                <form action={removeLineAction}>
                  <input type="hidden" name="variantId" value={line.variantId} />
                  <button type="submit" className="cart-line__remove">Remove</button>
                </form>
              </div>

              <p className="cart-line__total">
                <Money santim={line.lineTotalSantim} />
              </p>
            </li>
          ))}
        </ul>
      </div>

      <aside className="summary-card">
        <div className="summary-row">
          <span>Subtotal</span>
          <Money santim={cart.subtotalSantim} />
        </div>
        <div className="summary-row">
          <span>Shipping</span>
          <span>Calculated at checkout</span>
        </div>
        <div className="summary-row summary-row--total">
          <span>Total</span>
          <Money santim={cart.subtotalSantim} />
        </div>

        <Link
          href="/checkout"
          className="btn btn--primary btn--full btn--lg"
          style={{ marginTop: "var(--space-5)" }}
          aria-disabled={cart.hasStockIssues}
        >
          Checkout
        </Link>
      </aside>
    </div>
  );
}
