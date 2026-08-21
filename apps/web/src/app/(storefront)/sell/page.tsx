import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guard";
import { getSellerByOwnerId } from "@/server/sellers/seller-service";
import { SellerApplicationForm } from "@/components/seller-application-form";
import { StatusPill } from "@/components/status-pill";

export const metadata: Metadata = { title: "Sell on santim-commerce" };
export const dynamic = "force-dynamic";

const STATUS_COPY: Record<string, string> = {
  PENDING: "Your application is being reviewed. This usually takes 1-2 business days.",
  APPROVED: "You're an approved seller. Manage your store from the seller dashboard.",
  SUSPENDED: "Your seller account is currently suspended. Contact support for details.",
  REJECTED: "Your application was not approved.",
};

export default async function SellPage() {
  const user = await requireUser();
  const seller = await getSellerByOwnerId(user.id);

  return (
    <div className="container auth-page">
      <div className="auth-card">
        <h1>{seller ? seller.storeName : "Become a seller"}</h1>

        {seller ? (
          <>
            <p className="auth-card__subtitle" style={{ marginBottom: "var(--space-4)" }}>
              <StatusPill status={seller.status} />
            </p>
            <p>{STATUS_COPY[seller.status]}</p>
            {seller.status === "REJECTED" && seller.rejectionReason && (
              <p className="alert alert--error" style={{ marginTop: "var(--space-4)" }}>
                Reason: {seller.rejectionReason}
              </p>
            )}
            {seller.status === "APPROVED" && (
              <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-5)", flexWrap: "wrap" }}>
                <Link href="/sell/products" className="btn btn--primary" style={{ flex: 1 }}>
                  Your listings
                </Link>
                <Link href="/sell/orders" className="btn btn--secondary" style={{ flex: 1 }}>
                  Your sales
                </Link>
                <Link href="/sell/returns" className="btn btn--secondary" style={{ flex: 1 }}>
                  Returns
                </Link>
                <Link href="/sell/earnings" className="btn btn--secondary" style={{ flex: 1 }}>
                  Your earnings
                </Link>
                <Link href="/sell/coupons" className="btn btn--secondary" style={{ flex: 1 }}>
                  Your coupons
                </Link>
                <Link href="/sell/questions" className="btn btn--secondary" style={{ flex: 1 }}>
                  Your questions
                </Link>
                <Link href="/sell/messages" className="btn btn--secondary" style={{ flex: 1 }}>
                  Messages
                </Link>
                <Link href="/sell/reputation" className="btn btn--secondary" style={{ flex: 1 }}>
                  Your reputation
                </Link>
                <Link href="/sell/settings" className="btn btn--secondary" style={{ flex: 1 }}>
                  Store settings
                </Link>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="auth-card__subtitle">
              List your products and reach every customer on the marketplace. Applications are reviewed
              before your store goes live.
            </p>
            <SellerApplicationForm />
          </>
        )}
      </div>
    </div>
  );
}
