import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { getSellerReputation } from "@/server/sellers/seller-reputation-service";

export const metadata: Metadata = { title: "Your reputation" };
export const dynamic = "force-dynamic";

function formatPercent(rate: number | null): string {
  return rate == null ? "No data yet" : `${Math.round(rate * 100)}%`;
}

function formatHours(hours: number | null): string {
  if (hours == null) return "No data yet";
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

export default async function SellerReputationPage() {
  const seller = await requireApprovedSellerForPage();
  const rep = await getSellerReputation(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <div className="section-head">
        <h2>{seller.storeName} — reputation</h2>
      </div>

      <p className="form-hint" style={{ marginBottom: "var(--space-6)" }}>
        Computed from your real order, return, and review history. Late-shipment rate is measured
        against a default 48-hour fulfilment window, not a negotiated SLA. Review-response and
        dispute figures are based on the reviews and returns you have actually handled.
      </p>

      <div className="detail-card">
        <h3>Customer satisfaction</h3>
        <div className="summary-row">
          <span>Average rating</span>
          <span>{rep.averageRating != null ? `${rep.averageRating.toFixed(1)} / 5 (${rep.reviewCount} reviews)` : "No reviews yet"}</span>
        </div>
        <div className="summary-row">
          <span>Average review response time</span>
          <span>{formatHours(rep.avgReviewResponseHours)}</span>
        </div>
      </div>

      <div className="detail-card">
        <h3>Fulfilment</h3>
        <div className="summary-row">
          <span>Order lines total</span>
          <span>{rep.totalOrderLines}</span>
        </div>
        <div className="summary-row">
          <span>Order completion rate</span>
          <span>{formatPercent(rep.completionRate)}</span>
        </div>
        <div className="summary-row">
          <span>On-time shipment rate</span>
          <span>{rep.lateShipmentRate != null ? formatPercent(1 - rep.lateShipmentRate) : "No data yet"}</span>
        </div>
        <div className="summary-row">
          <span>Cancellation rate</span>
          <span>{formatPercent(rep.cancellationRate)}</span>
        </div>
        <div className="summary-row">
          <span>Return rate</span>
          <span>{formatPercent(rep.returnRate)}</span>
        </div>
      </div>

      <div className="detail-card">
        <h3>Disputes</h3>
        <div className="summary-row">
          <span>Returns needing admin escalation</span>
          <span>{formatPercent(rep.disputeRate)}</span>
        </div>
      </div>
    </div>
  );
}
