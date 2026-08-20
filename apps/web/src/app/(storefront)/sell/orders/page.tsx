import Link from "next/link";
import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { listSellerOrderLines } from "@/server/orders/seller-order-queries";
import { StatusPill } from "@/components/status-pill";
import { Money } from "@/components/money";

export const metadata: Metadata = { title: "Your sales" };
export const dynamic = "force-dynamic";

export default async function SellerOrdersPage() {
  const seller = await requireApprovedSellerForPage();
  const lines = await listSellerOrderLines(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{seller.storeName} — your sales</h2>
      </div>

      {lines.length === 0 ? (
        <div className="empty-state">
          <h2>No sales yet</h2>
          <p>Sold items will show up here once a customer&apos;s payment clears.</p>
        </div>
      ) : (
        <div>
          {lines.map((line) => (
            <Link
              key={line.id}
              href={`/sell/orders/${line.order.orderNumber}`}
              className="order-row"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div>
                <p className="order-row__number">{line.order.orderNumber}</p>
                <p className="order-row__items">
                  {line.productTitle} · {line.variantTitle} &times; {line.quantity}
                </p>
              </div>
              <div className="order-row__meta">
                <p className="order-row__total"><Money santim={line.lineTotalSantim} /></p>
                <StatusPill status={line.order.fulfilmentStatus} />
                <p>{line.order.placedAt.toISOString().slice(0, 10)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
