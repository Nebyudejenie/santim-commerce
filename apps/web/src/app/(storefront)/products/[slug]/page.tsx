import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug, totalAvailable } from "@/server/catalogue/catalogue-service";
import { AddToCartForm, type VariantOption } from "@/components/add-to-cart-form";
import { ProductImage } from "@/components/product-image";
import { StarRating } from "@/components/star-rating";
import { ReviewList } from "@/components/review-list";
import { ReviewForm } from "@/components/review-form";
import { getSessionUser } from "@/server/auth/session";
import {
  findEligibleOrderLine,
  getProductRating,
  hasReviewed,
  listProductReviews,
} from "@/server/reviews/review-service";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: "Product not found" };
  return {
    title: product.metaTitle ?? product.title,
    description: product.metaDescription ?? product.subtitle ?? undefined,
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const variants: VariantOption[] = product.variants.map((v) => ({
    id: v.id,
    title: v.title,
    priceSantim: v.priceSantim,
    options: v.options as Record<string, string>,
    available: totalAvailable(v.inventory),
  }));

  // Optional auth — the PDP itself is public, review-writing eligibility is
  // just an extra check for whoever (if anyone) is currently signed in.
  const user = await getSessionUser();
  const [rating, reviews, alreadyReviewed, eligibleLine] = await Promise.all([
    getProductRating(product.id),
    listProductReviews(product.id),
    user ? hasReviewed(user.id, product.id) : Promise.resolve(false),
    user ? findEligibleOrderLine(user.id, product.id) : Promise.resolve(null),
  ]);
  const canReview = user !== null && !alreadyReviewed && eligibleLine !== null;

  return (
    <div className="container pdp">
      <div className="pdp__gallery">
        {product.images.length > 0 ? (
          product.images.map((image) => (
            <div key={image.id} className="pdp__gallery-image">
              <ProductImage
                src={image.url}
                alt={image.alt}
                width={image.width ?? 1200}
                height={image.height ?? 1500}
                priority
              />
            </div>
          ))
        ) : (
          <div className="pdp__gallery-image" />
        )}
      </div>

      <div className="pdp__info">
        {product.brand && <p className="pdp__eyebrow">{product.brand}</p>}
        <h1 className="pdp__title">{product.title}</h1>
        {product.subtitle && <p className="pdp__subtitle">{product.subtitle}</p>}

        {rating.count > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
            <StarRating rating={rating.average ?? 0} />
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
              {rating.average?.toFixed(1)} ({rating.count} review{rating.count === 1 ? "" : "s"})
            </span>
          </div>
        )}

        <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)", marginBottom: "var(--space-4)" }}>
          Sold by <Link href={`/sellers/${product.seller.slug}`}>{product.seller.storeName}</Link>
        </p>

        {variants.length > 0 ? (
          <AddToCartForm variants={variants} />
        ) : (
          <p className="alert alert--error">No purchasable options for this product.</p>
        )}

        <p className="pdp__description">{product.description}</p>

        <div style={{ marginTop: "var(--space-8)" }}>
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>Reviews</h2>
          <ReviewList reviews={reviews} />
          {canReview && (
            <>
              <h3 style={{ fontSize: "var(--text-md)", marginTop: "var(--space-6)" }}>Write a review</h3>
              <ReviewForm productId={product.id} productSlug={product.slug} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
