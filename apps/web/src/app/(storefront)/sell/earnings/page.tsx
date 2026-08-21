import Link from "next/link";
import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { getSellerBalance, getSellerBusinessMetrics, listSellerLedgerEntries } from "@/server/orders/settlement-service";
import { Money } from "@/components/money";

export const metadata: Metadata = { title: "Your earnings" };
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  SALE: "Sale",
  COMMISSION: "Marketplace commission",
  REFUND: "Refund",
  ADJUSTMENT: "Adjustment",
  COUPON_DISCOUNT: "Coupon discount",
};

export default async function SellerEarningsPage() {
  const seller = await requireApprovedSellerForPage();
  const [balance, entries, metrics] = await Promise.all([
    getSellerBalance(seller.id),
    listSellerLedgerEntries(seller.id),
    getSellerBusinessMetrics(seller.id),
  ]);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <div className="section-head">
        <h2>{seller.storeName} — earnings</h2>
      </div>

      <h3 style={{ fontSize: "var(--text-sm)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-faint)", marginBottom: "var(--space-4)" }}>
        Business, last {metrics.windowDays} days
      </h3>
      <div className="stat-grid" style={{ marginBottom: "var(--space-6)" }}>
        <div className="stat-tile">
          <p className="stat-tile__label">Orders</p>
          <p className="stat-tile__value">{metrics.ordersCount}</p>
        </div>
        <div className="stat-tile">
          <p className="stat-tile__label">Gross sales</p>
          <p className="stat-tile__value"><Money santim={metrics.grossSalesSantim} /></p>
        </div>
        {metrics.marginSantim !== null && (
          <div className="stat-tile">
            <p className="stat-tile__label">Estimated margin</p>
            <p className="stat-tile__value"><Money santim={metrics.marginSantim} /></p>
            {metrics.unitsMissingCostData > 0 && (
              <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                {metrics.unitsMissingCostData} unit{metrics.unitsMissingCostData === 1 ? "" : "s"} missing cost data — set
                your cost per variant to include them
              </p>
            )}
          </div>
        )}
      </div>

      {metrics.topProducts.length > 0 && (
        <div className="detail-card" style={{ marginBottom: "var(--space-7)" }}>
          <h3>Top products</h3>
          <table className="admin-table">
            <thead>
              <tr><th>Product</th><th>Units</th><th>Revenue</th></tr>
            </thead>
            <tbody>
              {metrics.topProducts.map((p) => (
                <tr key={p.productTitle}>
                  <td>{p.productTitle}</td>
                  <td>{p.unitsSold}</td>
                  <td><Money santim={p.revenueSantim} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <aside className="summary-card" style={{ marginBottom: "var(--space-7)" }}>
        <div className="summary-row">
          <span>Awaiting payout</span>
          <Money santim={balance.payableSantim} />
        </div>
        <div className="summary-row">
          <span>Already paid out</span>
          <Money santim={balance.settledSantim} />
        </div>
        <div className="summary-row summary-row--total">
          <span>Lifetime net earnings</span>
          <Money santim={balance.lifetimeNetSantim} />
        </div>
        <p className="form-hint" style={{ marginTop: "var(--space-3)" }}>
          Payouts are not automated yet — this reflects what the marketplace owes you, based on real
          sales and commission, not a live transfer schedule.
        </p>
      </aside>

      {entries.length === 0 ? (
        <div className="empty-state">
          <h2>No earnings yet</h2>
          <p>Ledger entries appear here once a customer&apos;s payment for one of your items clears.</p>
        </div>
      ) : (
        <div>
          {entries.map((entry) => (
            <div key={entry.id} className="summary-row" style={{ borderBottom: "1px solid var(--border)", paddingBlock: "var(--space-3)" }}>
              <div>
                <span>{TYPE_LABEL[entry.type] ?? entry.type}</span>
                {entry.order && (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                    <Link href={`/sell/orders/${entry.order.orderNumber}`}>{entry.order.orderNumber}</Link>
                    {" · "}
                    {entry.createdAt.toISOString().slice(0, 10)}
                  </div>
                )}
              </div>
              <span style={{ color: entry.amountSantim < 0 ? "var(--danger)" : "var(--success)" }}>
                {entry.amountSantim < 0 ? "" : "+"}
                <Money santim={entry.amountSantim} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
