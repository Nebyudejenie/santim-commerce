import { listAllReturnRequests } from "@/server/orders/return-service";
import { StatusPill } from "@/components/status-pill";
import { AdminReturnActions } from "@/components/admin-return-actions";

export default async function AdminReturnsPage() {
  const requests = await listAllReturnRequests();

  return (
    <div>
      <div className="admin-header">
        <h1>Return requests</h1>
      </div>

      {requests.length === 0 ? (
        <p className="empty-note">No return requests.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Item</th>
              <th>Buyer</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>{request.order.orderNumber}</td>
                <td>{request.orderLine.productTitle} · {request.orderLine.variantTitle}</td>
                <td>{request.requestedBy.email}</td>
                <td style={{ maxWidth: "260px" }}>
                  {request.reason}
                  {request.disputeReason && (
                    <p style={{ marginTop: "var(--space-2)", color: "var(--fg-muted)", fontSize: "var(--text-xs)" }}>
                      Buyer&apos;s dispute: &ldquo;{request.disputeReason}&rdquo;
                    </p>
                  )}
                </td>
                <td><StatusPill status={request.status} /></td>
                <td>
                  {request.status === "REQUESTED" || request.status === "DISPUTED" ? (
                    <AdminReturnActions returnRequestId={request.id} />
                  ) : (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                      {request.resolutionNote}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
