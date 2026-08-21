import { notFound } from "next/navigation";
import Link from "next/link";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { getSellerOrderDetail } from "@/server/orders/seller-order-queries";
import { StatusPill } from "@/components/status-pill";
import { Money } from "@/components/money";
import { ProductImage } from "@/components/product-image";
import { FulfilmentToggle } from "@/components/fulfilment-toggle";
import { OpenSellerThreadButton } from "@/components/open-seller-thread-button";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ orderNumber: string }>;
}

interface ShippingAddress {
  fullName?: string;
  phone?: string;
  city?: string;
  streetLine?: string;
  shippingZone?: string;
}

export default async function SellerOrderDetailPage({ params }: Props) {
  const { orderNumber } = await params;
  const seller = await requireApprovedSellerForPage();
  // getSellerOrderDetail returns null for an order this seller has no line
  // in — same "indistinguishable from not found" discipline as every other
  // ownership-scoped query this session (get-user-orders.ts,
  // listing-service.ts).
  const detail = await getSellerOrderDetail(seller.id, orderNumber);
  if (!detail) notFound();

  const { order, lines } = detail;
  const address = (order.shippingAddress as ShippingAddress | null) ?? null;
  const total = lines.reduce((sum, l) => sum + l.lineTotalSantim, 0);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <p style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/sell/orders" style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          &larr; Your sales
        </Link>
      </p>

      <div className="section-head">
        <h2>{order.orderNumber}</h2>
        <StatusPill status={order.fulfilmentStatus} />
      </div>

      <p style={{ color: "var(--fg-muted)", marginBottom: "var(--space-6)" }}>
        Paid {order.paidAt ? order.paidAt.toISOString().slice(0, 10) : "—"}
      </p>

      {lines.map((line) => (
        <div key={line.id} className="cart-line">
          <div className="cart-line__image">
            {line.imageUrl && <ProductImage src={line.imageUrl} alt={line.productTitle} width={88} height={110} />}
          </div>
          <div>
            <p className="cart-line__title">{line.productTitle}</p>
            <p className="cart-line__variant">
              {line.variantTitle} &times; {line.quantity} · {line.sku}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
              <StatusPill status={line.fulfilmentStatus} />
              <FulfilmentToggle orderLineId={line.id} orderNumber={order.orderNumber} status={line.fulfilmentStatus} />
            </div>
          </div>
          <p className="cart-line__total">
            <Money santim={line.lineTotalSantim} />
          </p>
        </div>
      ))}

      <aside className="summary-card" style={{ marginTop: "var(--space-6)" }}>
        <div className="summary-row summary-row--total">
          <span>Your total</span>
          <Money santim={total} />
        </div>
      </aside>

      <div style={{ marginTop: "var(--space-6)" }}>
        <p style={{ fontWeight: 600, marginBottom: "var(--space-3)" }}>Ship to</p>
        {address ? (
          <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
            {address.fullName}<br />
            {address.streetLine}, {address.city}<br />
            {address.phone}
          </p>
        ) : (
          <p className="empty-note">No shipping address on file — contact the buyer at {order.email}.</p>
        )}
      </div>

      {order.customerNote && (
        <div style={{ marginTop: "var(--space-5)" }}>
          <p style={{ fontWeight: 600, marginBottom: "var(--space-3)" }}>Delivery notes from the buyer</p>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)", whiteSpace: "pre-wrap" }}>{order.customerNote}</p>
        </div>
      )}

      {/* Guest orders (no userId) have no account to open a thread with —
          see message-service.ts's own comment on why this is refused, not
          just hidden client-side. */}
      {order.userId && <OpenSellerThreadButton orderNumber={order.orderNumber} />}
    </div>
  );
}
