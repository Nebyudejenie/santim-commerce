import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guard";
import { getOrderForUser } from "@/server/orders/get-user-orders";
import { Money } from "@/components/money";
import { StatusPill } from "@/components/status-pill";
import { ProductImage } from "@/components/product-image";
import { RequestReturnButton } from "@/components/request-return-button";

export const metadata: Metadata = { title: "Order details" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ orderNumber: string }>;
}

export default async function AccountOrderDetailPage({ params }: Props) {
  const { orderNumber } = await params;
  const user = await requireUser();
  // Scoped to the signed-in user — see get-user-orders.ts's own comment:
  // must never return another user's order, so a guessed orderNumber in the
  // URL for someone else's order resolves to null, not their data.
  const order = await getOrderForUser(user.id, orderNumber);
  if (!order) notFound();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <p style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/account" style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          &larr; Your orders
        </Link>
      </p>

      <div className="section-head">
        <h2>{order.orderNumber}</h2>
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
              {line.fulfilmentStatus === "FULFILLED" && !line.returnRequest && (
                <RequestReturnButton orderLineId={line.id} orderNumber={order.orderNumber} />
              )}
              {line.returnRequest && (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
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
    </div>
  );
}
