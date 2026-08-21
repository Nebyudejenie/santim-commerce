import Link from "next/link";
import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { getSellerBalance, listSellerLedgerEntries } from "@/server/orders/settlement-service";
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
  const [balance, entries] = await Promise.all([
    getSellerBalance(seller.id),
    listSellerLedgerEntries(seller.id),
  ]);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <div className="section-head">
        <h2>{seller.storeName} — earnings</h2>
      </div>

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
