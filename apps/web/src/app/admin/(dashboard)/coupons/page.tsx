import { listCoupons } from "@/server/promotions/coupon-service";
import { StatusPill } from "@/components/status-pill";
import { CreateCouponForm } from "@/components/create-coupon-form";
import { ToggleCouponActiveButton } from "@/components/toggle-coupon-active-button";

function formatBirr(santim: number): string {
  return `${(santim / 100).toFixed(2)} ETB`;
}

export default async function AdminCouponsPage() {
  const coupons = await listCoupons();

  return (
    <div>
      <div className="admin-header">
        <h1>Coupons</h1>
      </div>

      <div className="detail-card">
        <h3>Create a coupon</h3>
        <CreateCouponForm />
      </div>

      {coupons.length === 0 ? (
        <p className="empty-note">No coupons yet.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Discount</th>
              <th>Min. subtotal</th>
              <th>Redemptions</th>
              <th>Valid</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {coupons.map((coupon) => (
              <tr key={coupon.id}>
                <td>
                  {coupon.code}
                  {coupon.description && (
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>{coupon.description}</div>
                  )}
                </td>
                <td>
                  {coupon.discountType === "PERCENTAGE"
                    ? `${coupon.discountValue}%`
                    : formatBirr(coupon.discountValue)}
                  {coupon.maxDiscountSantim != null && (
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                      up to {formatBirr(coupon.maxDiscountSantim)}
                    </div>
                  )}
                </td>
                <td>{coupon.minSubtotalSantim > 0 ? formatBirr(coupon.minSubtotalSantim) : "—"}</td>
                <td>
                  {coupon._count.redemptions}
                  {coupon.redemptionsRemaining != null ? ` / ${coupon._count.redemptions + coupon.redemptionsRemaining}` : ""}
                </td>
                <td style={{ fontSize: "var(--text-xs)" }}>
                  {coupon.validFrom ? coupon.validFrom.toISOString().slice(0, 10) : "—"}
                  {" – "}
                  {coupon.validUntil ? coupon.validUntil.toISOString().slice(0, 10) : "—"}
                </td>
                <td><StatusPill status={coupon.active ? "Active" : "Inactive"} /></td>
                <td>
                  <ToggleCouponActiveButton couponId={coupon.id} active={coupon.active} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
