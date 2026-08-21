import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guard";
import { listWishlist } from "@/server/wishlist/wishlist-service";
import { fromPriceSantim } from "@/server/catalogue/catalogue-service";
import { ProductImage } from "@/components/product-image";
import { WishlistButton } from "@/components/wishlist-button";
import { Money } from "@/components/money";

export const metadata: Metadata = { title: "Your wishlist" };
export const dynamic = "force-dynamic";

export default async function WishlistPage() {
  const user = await requireUser();
  const items = await listWishlist(user.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>Your wishlist</h2>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing saved yet</h2>
          <p style={{ marginBottom: "var(--space-6)" }}>Save products you&apos;re considering to find them again easily.</p>
          <Link href="/shop" className="btn btn--primary">Start shopping</Link>
        </div>
      ) : (
        <div className="product-grid">
          {items.map((item) => {
            const { product } = item;
            const isAvailable = product.status === "ACTIVE" && product.seller.status === "APPROVED";
            const image = product.images[0];
            const price = fromPriceSantim(product.variants);

            return (
              <div key={item.id} className="product-card">
                <div className="product-card__media">
                  {image && (
                    <ProductImage
                      src={image.url}
                      alt={image.alt}
                      width={image.width ?? 800}
                      height={image.height ?? 1000}
                      className="product-card__image"
                    />
                  )}
                  {!isAvailable && <span className="badge badge--muted product-card__badge">No longer available</span>}
                </div>
                <div className="product-card__body">
                  {isAvailable ? (
                    <Link href={`/products/${product.slug}`}>
                      <h3 className="product-card__title">{product.title}</h3>
                    </Link>
                  ) : (
                    <h3 className="product-card__title" style={{ color: "var(--fg-faint)" }}>{product.title}</h3>
                  )}
                  <p className="product-card__price">
                    {Number.isFinite(price) ? <Money santim={price} /> : "—"}
                  </p>
                  {Number.isFinite(price) && price < item.priceAtAddSantim && (
                    <p style={{ color: "var(--success)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                      Price dropped from <Money santim={item.priceAtAddSantim} />
                    </p>
                  )}
                  <div style={{ marginTop: "var(--space-3)" }}>
                    <WishlistButton productId={product.id} productSlug={product.slug} initialWishlisted={true} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
