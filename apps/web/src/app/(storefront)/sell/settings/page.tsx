import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { SellerProfileForm } from "@/components/seller-profile-form";

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
    </div>
  );
}
