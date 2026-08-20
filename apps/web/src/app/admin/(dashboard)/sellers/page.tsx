import { listAllSellers } from "@/server/sellers/seller-service";
import { StatusPill } from "@/components/status-pill";
import { SellerReviewActions } from "@/components/seller-review-actions";

export default async function AdminSellersPage() {
  const sellers = await listAllSellers();

  return (
    <div>
      <div className="admin-header">
        <h1>Sellers</h1>
      </div>

      {sellers.length === 0 ? (
        <p className="empty-note">No seller applications yet.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Store</th>
              <th>Status</th>
              <th>Commission</th>
              <th>Applied</th>
              <th>Reviewed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sellers.map((seller) => (
              <tr key={seller.id}>
                <td>
                  {seller.storeName}
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>/{seller.slug}</div>
                </td>
                <td><StatusPill status={seller.status} /></td>
                <td>{(seller.commissionBps / 100).toFixed(2)}%</td>
                <td>{seller.createdAt.toISOString().slice(0, 10)}</td>
                <td>
                  {seller.reviewedAt ? seller.reviewedAt.toISOString().slice(0, 10) : "—"}
                  {seller.status === "REJECTED" && seller.rejectionReason && (
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                      {seller.rejectionReason}
                    </div>
                  )}
                </td>
                <td>
                  <SellerReviewActions sellerId={seller.id} status={seller.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
