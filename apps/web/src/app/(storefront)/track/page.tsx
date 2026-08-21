import Link from "next/link";
import type { Metadata } from "next";
import { getOrderForGuestLookup } from "@/server/orders/guest-order-lookup-service";
import { Money } from "@/components/money";
import { StatusPill } from "@/components/status-pill";
import { ProductImage } from "@/components/product-image";

export const metadata: Metadata = { title: "Track your order" };
export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ orderNumber?: string; email?: string }>;
}

export default async function TrackOrderPage({ searchParams }: Props) {
  const { orderNumber, email } = await searchParams;
  const searched = Boolean(orderNumber && email);
  const order = searched ? await getOrderForGuestLookup(orderNumber!, email!) : null;

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "620px" }}>
      <div className="section-head">
        <h2>Track your order</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-6)" }}>
        Enter your order number and the email address you used at checkout. If you have an account,
        you can also <Link href="/login">sign in</Link> to see all your orders in one place.
      </p>

      <form method="get" className="form-row form-row--2" style={{ marginBottom: "var(--space-6)" }}>
        <div className="form-field">
          <label htmlFor="orderNumber">Order number</label>
          <input id="orderNumber" name="orderNumber" type="text" placeholder="SC-XXXXXXXX" defaultValue={orderNumber ?? ""} required />
        </div>
        <div className="form-field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" defaultValue={email ?? ""} required />
        </div>
        <button type="submit" className="btn btn--primary" style={{ gridColumn: "1 / -1" }}>
          Find my order
        </button>
      </form>

      {searched && !order && (
        <p className="alert alert--error">
          We couldn&apos;t find an order matching that order number and email. Double-check both and try again.
        </p>
      )}

      {order && (
        <div>
          <div className="section-head">
            <h3>{order.orderNumber}</h3>
            <StatusPill status={order.status} />
          </div>
          <p style={{ color: "var(--fg-muted)", marginBottom: "var(--space-6)" }}>
            Placed {order.placedAt.toISOString().slice(0, 10)}
          </p>

          {order.lines.map((line) => (
            <div key={line.id} className="cart-line">
              <div className="cart-line__image">
                {line.imageUrl && <ProductImage src={line.imageUrl} alt={line.productTitle} width={88} height={110} />}
              </div>
              <div>
                <p className="cart-line__title">{line.productTitle}</p>
                <p className="cart-line__variant">
                  {line.variantTitle} &times; {line.quantity}
                </p>
                <div style={{ marginTop: "var(--space-2)" }}>
                  <StatusPill status={line.fulfilmentStatus} />
                  {line.returnRequest && (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)", marginLeft: "var(--space-2)" }}>
                      Return: <StatusPill status={line.returnRequest.status} />
                    </span>
                  )}
                </div>
              </div>
              <p className="cart-line__total">
                <Money santim={line.lineTotalSantim} />
              </p>
            </div>
          ))}

          <aside className="summary-card" style={{ marginTop: "var(--space-6)" }}>
            <div className="summary-row">
              <span>Subtotal</span>
              <Money santim={order.subtotalSantim} />
            </div>
            {order.discountSantim > 0 && (
              <div className="summary-row">
                <span>Discount</span>
                <span>&minus;<Money santim={order.discountSantim} /></span>
              </div>
            )}
            <div className="summary-row">
              <span>Shipping</span>
              <Money santim={order.shippingSantim} />
            </div>
            <div className="summary-row">
              <span>VAT</span>
              <Money santim={order.taxSantim} />
            </div>
            <div className="summary-row summary-row--total">
              <span>Total</span>
              <Money santim={order.totalSantim} />
            </div>
          </aside>

          {order.payments.length > 0 && (
            <div style={{ marginTop: "var(--space-6)" }}>
              <p style={{ fontWeight: 600, marginBottom: "var(--space-3)" }}>Payment</p>
              {order.payments.map((payment) => (
                <div key={payment.id} className="summary-row">
                  <span>{payment.channel ?? "Payment attempt"}</span>
                  <StatusPill status={payment.status} />
                </div>
              ))}
            </div>
          )}

          <p className="form-hint" style={{ marginTop: "var(--space-4)" }}>
            Need to cancel this order or start a return? <Link href="/login">Sign in</Link> to manage it from
            your account, or <Link href="/register">create one</Link> using this same email address.
          </p>
        </div>
      )}
    </div>
  );
}
