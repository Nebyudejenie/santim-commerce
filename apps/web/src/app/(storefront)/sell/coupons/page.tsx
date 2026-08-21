import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { listCouponsForSeller } from "@/server/promotions/coupon-service";
import { createSellerCouponAction, toggleSellerCouponActiveAction } from "@/server/actions/coupon-actions";
import { StatusPill } from "@/components/status-pill";
import { CreateCouponForm } from "@/components/create-coupon-form";
import { ToggleCouponActiveButton } from "@/components/toggle-coupon-active-button";

export const metadata: Metadata = { title: "Your coupons" };
export const dynamic = "force-dynamic";

function formatBirr(santim: number): string {
  return `${(santim / 100).toFixed(2)} ETB`;
}

export default async function SellerCouponsPage() {
  const seller = await requireApprovedSellerForPage();
  const coupons = await listCouponsForSeller(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{seller.storeName} — coupons</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-6)" }}>
        A coupon you create only discounts YOUR OWN items in a customer&apos;s cart — never another
        seller&apos;s — and the discount comes out of your own payout, the same way a REFUND does.
      </p>

      <div className="detail-card" style={{ marginBottom: "var(--space-7)" }}>
        <h3>Create a coupon</h3>
        <CreateCouponForm action={createSellerCouponAction} />
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
                  <ToggleCouponActiveButton couponId={coupon.id} active={coupon.active} action={toggleSellerCouponActiveAction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
