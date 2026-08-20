import Link from "next/link";
import { Money } from "./money";
import { ProductImage } from "./product-image";
import { fromPriceSantim, totalAvailable } from "@/server/catalogue/catalogue-service";

export interface ProductCardData {
  slug: string;
  title: string;
  subtitle: string | null;
  heroImage: string | null;
  images: { url: string; alt: string; width: number | null; height: number | null }[];
  variants: { priceSantim: number; inventory: { onHand: number; reserved: number } | null }[];
}

export function ProductCard({ product, index = 0 }: { product: ProductCardData; index?: number }) {
  const image = product.images[0];
  const price = fromPriceSantim(product.variants);
  const available = product.variants.reduce((sum, v) => sum + totalAvailable(v.inventory), 0);
  const lowStock = available > 0 && available <= 5;
  const soldOut = available === 0;

  return (
    <Link
      href={`/products/${product.slug}`}
      className="product-card rise-in"
      style={{ "--stagger": index } as React.CSSProperties}
    >
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
        {soldOut && <span className="badge badge--muted product-card__badge">Sold out</span>}
        {!soldOut && lowStock && <span className="badge badge--warn product-card__badge">Low stock</span>}
      </div>
      <div className="product-card__body">
        <h3 className="product-card__title">{product.title}</h3>
        {product.subtitle && <p className="product-card__subtitle">{product.subtitle}</p>}
        <p className="product-card__price">
          {Number.isFinite(price) ? <Money santim={price} /> : "—"}
        </p>
      </div>
    </Link>
  );
}
