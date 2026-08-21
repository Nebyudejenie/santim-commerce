import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug, listRelatedProducts, totalAvailable } from "@/server/catalogue/catalogue-service";
import { AddToCartForm, type VariantOption } from "@/components/add-to-cart-form";
import { ProductImage } from "@/components/product-image";
import { ProductCard } from "@/components/product-card";
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
import { isWishlisted, listWishlistedProductIds } from "@/server/wishlist/wishlist-service";
import { WishlistButton } from "@/components/wishlist-button";
import { listQuestionsForProduct } from "@/server/reviews/product-qa-service";
import { AskQuestionForm } from "@/components/ask-question-form";
import { recordView } from "@/server/catalogue/recently-viewed-service";
import { listPendingRequestedVariantIds } from "@/server/catalogue/back-in-stock-service";
import { logger } from "@/server/observability/logger";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: "Product not found" };

  const title = product.metaTitle ?? product.title;
  const description = product.metaDescription ?? product.subtitle ?? undefined;
  const image = product.images[0]?.url ?? product.heroImage ?? undefined;

  return {
    title,
    description,
    alternates: { canonical: `/products/${slug}` },
    openGraph: {
      title,
      description,
      type: "website",
      images: image ? [{ url: image }] : undefined,
    },
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
    compareAtSantim: v.compareAtSantim,
    options: v.options as Record<string, string>,
    available: totalAvailable(v.inventory),
    lowStockThreshold: v.inventory?.lowStockThreshold ?? 5,
  }));

  // Optional auth — the PDP itself is public, review-writing eligibility is
  // just an extra check for whoever (if anyone) is currently signed in.
  const user = await getSessionUser();

  // Best-effort, never blocks or breaks the page — see
  // recently-viewed-service.ts's own comment on why a GET-time write is a
  // deliberate, accepted exception here.
  if (user) {
    try {
      await recordView(user.id, product.id);
    } catch (error) {
      logger.error("recently_viewed.record_failed", { userId: user.id, productId: product.id, error: (error as Error).message });
    }
  }

  const [rating, reviews, alreadyReviewed, eligibleLine, alreadyWishlisted, questions, requestedVariantIds, relatedProducts] =
    await Promise.all([
      getProductRating(product.id),
      listProductReviews(product.id),
      user ? hasReviewed(user.id, product.id) : Promise.resolve(false),
      user ? findEligibleOrderLine(user.id, product.id) : Promise.resolve(null),
      user ? isWishlisted(user.id, product.id) : Promise.resolve(false),
      listQuestionsForProduct(product.id),
      user ? listPendingRequestedVariantIds(user.id, product.variants.map((v) => v.id)) : Promise.resolve(new Set<string>()),
      listRelatedProducts(product.sellerId, product.id),
    ]);
  const canReview = user !== null && !alreadyReviewed && eligibleLine !== null;
  const relatedWishlistedIds = user ? await listWishlistedProductIds(user.id) : new Set<string>();

  const priceValues = variants.map((v) => v.priceSantim / 100);
  const totalAvailableStock = variants.reduce((sum, v) => sum + v.available, 0);
  const image = product.images[0]?.url ?? product.heroImage;

  // Real data only — no fabricated aggregateRating when there are no
  // reviews, no invented brand/price when the catalogue doesn't have one.
  // A search engine penalizes structured data that doesn't match what a
  // user actually sees on the page far more than it rewards having some.
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description,
    ...(product.brand && { brand: { "@type": "Brand", name: product.brand } }),
    ...(image && { image: [image] }),
    ...(priceValues.length > 0 && {
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "ETB",
        lowPrice: Math.min(...priceValues).toFixed(2),
        highPrice: Math.max(...priceValues).toFixed(2),
        offerCount: priceValues.length,
        availability: totalAvailableStock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      },
    }),
    ...(rating.count > 0 && rating.average != null && {
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: rating.average.toFixed(1),
        reviewCount: rating.count,
      },
    }),
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "/" },
      { "@type": "ListItem", position: 2, name: "Shop", item: "/shop" },
      { "@type": "ListItem", position: 3, name: product.title, item: `/products/${product.slug}` },
    ],
  };

  return (
    <div className="container">
      <script type="application/ld+json">{JSON.stringify(productJsonLd)}</script>
      <script type="application/ld+json">{JSON.stringify(breadcrumbJsonLd)}</script>

      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/">Home</Link>
        <span aria-hidden="true"> / </span>
        <Link href="/shop">Shop</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{product.title}</span>
      </nav>

      <div className="pdp">
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

        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start", marginBottom: "var(--space-4)" }}>
          {variants.length > 0 ? (
            <div style={{ flex: 1 }}>
              <AddToCartForm variants={variants} signedIn={Boolean(user)} requestedVariantIds={[...requestedVariantIds]} />
            </div>
          ) : (
            <p className="alert alert--error" style={{ flex: 1 }}>No purchasable options for this product.</p>
          )}

          {user ? (
            <WishlistButton productId={product.id} productSlug={product.slug} initialWishlisted={alreadyWishlisted} />
          ) : (
            <Link href="/login" className="wishlist-button">Save</Link>
          )}
        </div>

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

        <div id="questions" style={{ marginTop: "var(--space-8)" }}>
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>Questions & answers</h2>
          {questions.length === 0 ? (
            <p className="empty-note">No questions yet.</p>
          ) : (
            <div>
              {questions.map((q) => (
                <div key={q.id} style={{ borderBottom: "1px solid var(--border)", paddingBlock: "var(--space-4)" }}>
                  <p style={{ fontWeight: 600 }}>Q: {q.question}</p>
                  {q.answer ? (
                    <p style={{ color: "var(--fg-muted)", marginTop: "var(--space-2)" }}>A: {q.answer}</p>
                  ) : (
                    <p className="form-hint" style={{ marginTop: "var(--space-2)" }}>Awaiting a reply from the seller.</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {user ? (
            <div style={{ marginTop: "var(--space-6)" }}>
              <AskQuestionForm productId={product.id} productSlug={product.slug} />
            </div>
          ) : (
            <p className="form-hint" style={{ marginTop: "var(--space-4)" }}>
              <Link href="/login">Sign in</Link> to ask a question.
            </p>
          )}
        </div>
      </div>
      </div>

      {relatedProducts.length > 0 && (
        <div style={{ marginTop: "var(--space-8)" }}>
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>
            More from {product.seller.storeName}
          </h2>
          <div className="product-grid">
            {relatedProducts.map((related, i) => (
              <ProductCard
                key={related.id}
                product={related}
                index={i}
                signedIn={Boolean(user)}
                wishlisted={relatedWishlistedIds.has(related.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
