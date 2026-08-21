import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ProductCard } from "@/components/product-card";
import { ProductImage } from "@/components/product-image";
import { SellerTrustSignals } from "@/components/seller-trust-signals";
import { getSellerStorefront } from "@/server/catalogue/catalogue-service";
import { getSellerReputation } from "@/server/sellers/seller-reputation-service";
import { getSessionUser } from "@/server/auth/session";
import { listWishlistedProductIds } from "@/server/wishlist/wishlist-service";

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
  const [reputation, user] = await Promise.all([getSellerReputation(seller.id), getSessionUser()]);
  const wishlistedIds = user ? await listWishlistedProductIds(user.id) : new Set<string>();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head" style={{ alignItems: "center", gap: "var(--space-3)" }}>
        {seller.logoUrl && (
          <ProductImage src={seller.logoUrl} alt={`${seller.storeName} logo`} width={48} height={48} style={{ borderRadius: "var(--radius-full)", objectFit: "cover" }} />
        )}
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
            <ProductCard key={product.id} product={product} index={i} signedIn={Boolean(user)} wishlisted={wishlistedIds.has(product.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
