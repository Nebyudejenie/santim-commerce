import Link from "next/link";
import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { listSellerProducts } from "@/server/catalogue/listing-service";
import { StatusPill } from "@/components/status-pill";

export const metadata: Metadata = { title: "Your listings" };
export const dynamic = "force-dynamic";

export default async function SellerProductsPage() {
  const seller = await requireApprovedSellerForPage();
  const products = await listSellerProducts(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)" }}>
      <div className="section-head">
        <h2>{seller.storeName} — your listings</h2>
        <Link href="/sell/products/new" className="btn btn--primary btn-sm">New listing</Link>
      </div>

      {products.length === 0 ? (
        <div className="empty-state">
          <h2>No listings yet</h2>
          <p style={{ marginBottom: "var(--space-6)" }}>Create your first listing to start selling.</p>
          <Link href="/sell/products/new" className="btn btn--primary">New listing</Link>
        </div>
      ) : (
        <div>
          {products.map((product) => {
            const totalStock = product.variants.reduce((sum, v) => sum + (v.inventory?.onHand ?? 0), 0);
            return (
              <Link
                key={product.id}
                href={`/sell/products/${product.id}`}
                className="order-row"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div>
                  <p className="order-row__number">{product.title}</p>
                  <p className="order-row__items">
                    {product.variants.length} variant{product.variants.length === 1 ? "" : "s"} · {totalStock} in stock
                  </p>
                </div>
                <div className="order-row__meta">
                  <StatusPill status={product.status} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
