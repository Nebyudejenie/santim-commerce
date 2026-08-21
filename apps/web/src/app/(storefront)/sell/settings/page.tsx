import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { SellerProfileForm } from "@/components/seller-profile-form";
import { SellerVacationToggle } from "@/components/seller-vacation-toggle";

export const metadata: Metadata = { title: "Store settings" };
export const dynamic = "force-dynamic";

export default async function SellerSettingsPage() {
  const seller = await requireApprovedSellerForPage();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "460px" }}>
      <div className="section-head">
        <h2>Store settings</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-6)" }}>
        This is what customers see on your storefront page. Your store URL (/sellers/{seller.slug}) stays
        the same.
      </p>

      <SellerProfileForm storeName={seller.storeName} description={seller.description} logoUrl={seller.logoUrl} />

      <div className="section-head" style={{ marginTop: "var(--space-8)" }}>
        <h2>Store status</h2>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-4)" }}>
        {seller.vacationAt
          ? "Your store is currently paused — none of your listings are visible to customers."
          : "Going away for a while? Pause your store and every listing becomes temporarily invisible to customers, without touching your listings themselves."}
      </p>
      <SellerVacationToggle onVacation={seller.vacationAt !== null} />
    </div>
  );
}
