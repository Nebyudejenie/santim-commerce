import Link from "next/link";
import { Money } from "./money";
import { ProductImage } from "./product-image";
import { WishlistButton } from "./wishlist-button";
import { fromPriceSantim, totalAvailable } from "@/server/catalogue/catalogue-service";

export interface ProductCardData {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  heroImage: string | null;
  images: { url: string; alt: string; width: number | null; height: number | null }[];
  variants: { priceSantim: number; inventory: { onHand: number; reserved: number; lowStockThreshold: number } | null }[];
}

export function ProductCard({
  product,
  index = 0,
  signedIn = false,
  wishlisted = false,
}: {
  product: ProductCardData;
  index?: number;
  /** Whether the CURRENT viewer is signed in — controls whether the wishlist
   * button is interactive or a plain "sign in to save" link, same as the PDP. */
  signedIn?: boolean;
  /** Whether the CURRENT viewer already has this product saved. Ignored when signedIn is false. */
  wishlisted?: boolean;
}) {
  const image = product.images[0];
  const price = fromPriceSantim(product.variants);
  const available = product.variants.reduce((sum, v) => sum + totalAvailable(v.inventory), 0);
  // The most conservative real per-variant threshold, not a fixed number —
  // same fix already applied to the PDP's own stock note. Using the MAX
  // across variants means the badge fires as soon as ANY variant's own
  // real threshold would flag it, for an aggregated total with no single
  // natural threshold of its own.
  const lowStockThreshold =
    product.variants.length > 0 ? Math.max(...product.variants.map((v) => v.inventory?.lowStockThreshold ?? 5)) : 5;
  const lowStock = available > 0 && available <= lowStockThreshold;
  const soldOut = available === 0;

  return (
    <div className="product-card rise-in" style={{ "--stagger": index } as React.CSSProperties}>
      <div className="product-card__media">
        <Link href={`/products/${product.slug}`} className="product-card__media-link" tabIndex={-1} aria-hidden="true">
          {image && (
            <ProductImage
              src={image.url}
              alt={image.alt}
              width={image.width ?? 800}
              height={image.height ?? 1000}
              className="product-card__image"
            />
          )}
        </Link>
        {soldOut && <span className="badge badge--muted product-card__badge">Sold out</span>}
        {!soldOut && lowStock && <span className="badge badge--warn product-card__badge">Low stock</span>}
        {/* A sibling of the Link above, never nested inside it — an <a>
         * cannot legally contain interactive content like a <form>/<button>. */}
        {signedIn ? (
          <WishlistButton productId={product.id} productSlug={product.slug} initialWishlisted={wishlisted} compact />
        ) : (
          <Link href="/login" className="wishlist-button wishlist-button--compact product-card__wishlist" aria-label="Sign in to save">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 20.5s-7.5-4.6-10-9.1C0.5 8.2 2 4.5 5.5 4c2.1-.3 4 .8 6.5 3.3C14.5 4.8 16.4 3.7 18.5 4c3.5.5 5 4.2 3.5 7.4-2.5 4.5-10 9.1-10 9.1Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        )}
      </div>
      <Link href={`/products/${product.slug}`} className="product-card__body-link">
        <div className="product-card__body">
          <h3 className="product-card__title">{product.title}</h3>
          {product.subtitle && <p className="product-card__subtitle">{product.subtitle}</p>}
          <p className="product-card__price">
            {Number.isFinite(price) ? <Money santim={price} /> : "—"}
          </p>
        </div>
      </Link>
    </div>
  );
}
