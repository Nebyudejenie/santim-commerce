import Image from "next/image";
import Link from "next/link";
import { ProductCard } from "@/components/product-card";
import { listCollections, listFeaturedProducts } from "@/server/catalogue/catalogue-service";
import { getSessionUser } from "@/server/auth/session";
import { listWishlistedProductIds } from "@/server/wishlist/wishlist-service";

export default async function HomePage() {
  const [featured, collections, user] = await Promise.all([
    listFeaturedProducts(4),
    listCollections(),
    getSessionUser(),
  ]);
  const wishlistedIds = user ? await listWishlistedProductIds(user.id) : new Set<string>();

  return (
    <>
      <section className="hero">
        <div className="hero__media">
          <Image
            src="https://picsum.photos/seed/lumen-hero/1800/1400"
            alt="A model wearing the LUMEN Meridian Parka against a concrete backdrop"
            fill
            priority
            sizes="100vw"
            style={{ objectFit: "cover" }}
          />
        </div>
        <div className="hero__scrim" />
        <div className="container">
          <div className="hero__content">
            <p className="hero__eyebrow">New season</p>
            <h1 className="hero__title">Built for the in-between weather.</h1>
            <p className="hero__body">
              Shells, knits, and low-profile footwear designed in Addis Ababa. Pay instantly with
              Telebirr, CBE Birr, or Amole at checkout.
            </p>
            <Link href="/collections/new-arrivals" className="btn btn--light btn--lg">
              Shop new arrivals
            </Link>
          </div>
        </div>
      </section>

      <section className="container" style={{ marginTop: "var(--space-9)" }}>
        <div className="section-head">
          <h2>Shop by collection</h2>
        </div>
        <div className="collection-strip">
          {collections.map((c) => (
            <Link key={c.id} href={`/collections/${c.slug}`} className="collection-tile">
              {c.heroImage && (
                <Image src={c.heroImage} alt={c.title} fill sizes="(min-width: 900px) 25vw, 45vw" style={{ objectFit: "cover" }} />
              )}
              <div className="collection-tile__scrim" />
              <span className="collection-tile__label">{c.title}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="container" style={{ marginTop: "var(--space-9)", marginBottom: "var(--space-9)" }}>
        <div className="section-head">
          <h2>Featured</h2>
          <Link href="/shop">View all</Link>
        </div>
        <div className="product-grid">
          {featured.map((product, i) => (
            <ProductCard key={product.id} product={product} index={i} signedIn={Boolean(user)} wishlisted={wishlistedIds.has(product.id)} />
          ))}
        </div>
      </section>
    </>
  );
}
