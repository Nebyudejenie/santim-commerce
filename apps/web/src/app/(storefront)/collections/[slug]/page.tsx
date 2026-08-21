import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ProductCard } from "@/components/product-card";
import { getCollectionWithProducts, listCollections } from "@/server/catalogue/catalogue-service";
import { getSessionUser } from "@/server/auth/session";
import { listWishlistedProductIds } from "@/server/wishlist/wishlist-service";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const collection = await getCollectionWithProducts(slug);
  return { title: collection?.title ?? "Collection" };
}

export default async function CollectionPage({ params }: Props) {
  const { slug } = await params;
  const [collection, collections, user] = await Promise.all([
    getCollectionWithProducts(slug),
    listCollections(),
    getSessionUser(),
  ]);

  if (!collection) notFound();

  const products = collection.products.map((cp) => cp.product);
  const wishlistedIds = user ? await listWishlistedProductIds(user.id) : new Set<string>();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{collection.title}</h2>
      </div>
      {collection.description && (
        <p style={{ color: "var(--fg-muted)", maxWidth: "60ch", marginBottom: "var(--space-6)" }}>
          {collection.description}
        </p>
      )}

      <div className="filter-row" role="tablist" aria-label="Filter by collection">
        <Link href="/shop" className="filter-chip">All</Link>
        {collections.map((c) => (
          <Link
            key={c.id}
            href={`/collections/${c.slug}`}
            className="filter-chip"
            aria-current={c.slug === slug ? "page" : undefined}
          >
            {c.title}
          </Link>
        ))}
      </div>

      {products.length === 0 ? (
        <div className="empty-state">
          <h2>No products in this collection yet</h2>
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
