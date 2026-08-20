import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { listReturnRequestsForSeller } from "@/server/orders/return-service";
import { StatusPill } from "@/components/status-pill";
import { ReturnReviewActions } from "@/components/return-review-actions";

export const metadata: Metadata = { title: "Return requests" };
export const dynamic = "force-dynamic";

export default async function SellerReturnsPage() {
  const seller = await requireApprovedSellerForPage();
  const requests = await listReturnRequestsForSeller(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{seller.storeName} — return requests</h2>
      </div>

      {requests.length === 0 ? (
        <div className="empty-state">
          <h2>No return requests</h2>
        </div>
      ) : (
        <div>
          {requests.map((request) => (
            <div key={request.id} className="order-row" style={{ alignItems: "flex-start" }}>
              <div>
                <p className="order-row__number">{request.order.orderNumber}</p>
                <p className="order-row__items">{request.orderLine.productTitle} · {request.orderLine.variantTitle}</p>
                <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)", marginTop: "var(--space-2)" }}>
                  &ldquo;{request.reason}&rdquo;
                </p>
              </div>
              <div className="order-row__meta">
                <StatusPill status={request.status} />
                <p>{request.createdAt.toISOString().slice(0, 10)}</p>
                {request.status === "REQUESTED" && (
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <ReturnReviewActions returnRequestId={request.id} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
