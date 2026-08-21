import Link from "next/link";
import type { Metadata } from "next";
import { ProductCard } from "@/components/product-card";
import { listAllProducts, listCollections } from "@/server/catalogue/catalogue-service";
import { getSessionUser } from "@/server/auth/session";
import { listWishlistedProductIds } from "@/server/wishlist/wishlist-service";

export const metadata: Metadata = { title: "Shop" };

export default async function ShopPage() {
  const [products, collections, user] = await Promise.all([listAllProducts(), listCollections(), getSessionUser()]);
  const wishlistedIds = user ? await listWishlistedProductIds(user.id) : new Set<string>();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>All products</h2>
      </div>

      <div className="filter-row" role="tablist" aria-label="Filter by collection">
        <Link href="/shop" className="filter-chip" aria-current="page">All</Link>
        {collections.map((c) => (
          <Link key={c.id} href={`/collections/${c.slug}`} className="filter-chip">
            {c.title}
          </Link>
        ))}
      </div>

      {products.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing here yet</h2>
          <p>Run the seed script to populate the catalogue.</p>
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
