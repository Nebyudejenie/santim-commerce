import { StarRating } from "./star-rating";
import type { SellerReputationMetrics } from "@/server/sellers/seller-reputation-service";

function formatPercent(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Buyer-facing subset only — no dispute rate or review-response time,
 * which are internal seller-performance signals, not something a shopper
 * needs to make a purchase decision. */
export function SellerTrustSignals({ reputation }: { reputation: SellerReputationMetrics }) {
  return (
    <div className="trust-signals">
      {reputation.averageRating != null && (
        <div className="trust-signals__item">
          <StarRating rating={reputation.averageRating} />
          <span>
            {reputation.averageRating.toFixed(1)} ({reputation.reviewCount} review{reputation.reviewCount === 1 ? "" : "s"})
          </span>
        </div>
      )}
      {reputation.completionRate != null && (
        <div className="trust-signals__item">
          <span className="trust-signals__label">Order completion</span>
          <span>{formatPercent(reputation.completionRate)}</span>
        </div>
      )}
      {reputation.returnRate != null && (
        <div className="trust-signals__item">
          <span className="trust-signals__label">Return rate</span>
          <span>{formatPercent(reputation.returnRate)}</span>
        </div>
      )}
    </div>
  );
}
