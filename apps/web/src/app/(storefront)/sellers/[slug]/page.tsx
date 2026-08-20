import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ProductCard } from "@/components/product-card";
import { SellerTrustSignals } from "@/components/seller-trust-signals";
import { getSellerStorefront } from "@/server/catalogue/catalogue-service";
import { getSellerReputation } from "@/server/sellers/seller-reputation-service";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const storefront = await getSellerStorefront(slug);
  return { title: storefront ? storefront.seller.storeName : "Seller not found" };
}

export default async function SellerStorefrontPage({ params }: Props) {
  const { slug } = await params;
  const storefront = await getSellerStorefront(slug);
  if (!storefront) notFound();

  const { seller, products } = storefront;
  const reputation = await getSellerReputation(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{seller.storeName}</h2>
      </div>
      {seller.description && (
        <p style={{ color: "var(--fg-muted)", maxWidth: "60ch", marginBottom: "var(--space-4)" }}>
          {seller.description}
        </p>
      )}
      <SellerTrustSignals reputation={reputation} />

      {products.length === 0 ? (
        <div className="empty-state">
          <h2>No listings yet</h2>
        </div>
      ) : (
        <div className="product-grid">
          {products.map((product, i) => (
            <ProductCard key={product.id} product={product} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
