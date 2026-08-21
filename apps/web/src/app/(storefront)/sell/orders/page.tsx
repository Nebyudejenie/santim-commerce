import Link from "next/link";
import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { listSellerOrderLines } from "@/server/orders/seller-order-queries";
import { StatusPill } from "@/components/status-pill";
import { Money } from "@/components/money";

export const metadata: Metadata = { title: "Your sales" };
export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ q?: string; fulfilmentStatus?: string }>;
}

const FULFILMENT_OPTIONS = ["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED", "RETURNED"] as const;

export default async function SellerOrdersPage({ searchParams }: Props) {
  const { q, fulfilmentStatus } = await searchParams;
  const seller = await requireApprovedSellerForPage();
  const validStatus = FULFILMENT_OPTIONS.find((s) => s === fulfilmentStatus);
  const lines = await listSellerOrderLines(seller.id, { search: q, fulfilmentStatus: validStatus });

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{seller.storeName} — your sales</h2>
      </div>

      <form method="get" style={{ marginBottom: "var(--space-5)", display: "flex", gap: "var(--space-3)" }}>
        <input type="text" name="q" defaultValue={q ?? ""} placeholder="Order number or buyer email…" style={{ maxWidth: "280px" }} />
        <select name="fulfilmentStatus" defaultValue={fulfilmentStatus ?? ""}>
          <option value="">All statuses</option>
          {FULFILMENT_OPTIONS.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <button type="submit" className="btn btn--secondary btn-sm">Filter</button>
      </form>

      {lines.length === 0 ? (
        <div className="empty-state">
          <h2>{q || fulfilmentStatus ? "No matching sales" : "No sales yet"}</h2>
          <p>
            {q || fulfilmentStatus
              ? "Try a different search or clear the filter."
              : "Sold items will show up here once a customer's payment clears."}
          </p>
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
