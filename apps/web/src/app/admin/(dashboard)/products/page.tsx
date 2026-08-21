import Link from "next/link";
import type { Metadata } from "next";
import { listAllProductsForAdmin } from "@/server/admin/admin-queries";
import { StatusPill } from "@/components/status-pill";
import { ToggleFeaturedButton } from "@/components/toggle-featured-button";

export const metadata: Metadata = { title: "Products" };
export const dynamic = "force-dynamic";

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const products = await listAllProductsForAdmin(q);

  return (
    <div>
      <div className="admin-header">
        <h1>Products</h1>
      </div>

      <form method="get" style={{ marginBottom: "var(--space-5)" }}>
        <input type="text" name="q" defaultValue={q ?? ""} placeholder="Search by title…" style={{ maxWidth: "320px" }} />
      </form>

      {products.length === 0 ? (
        <p className="empty-note">No products found.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Seller</th>
              <th>Status</th>
              <th>Featured</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td><Link href={`/products/${p.slug}`}>{p.title}</Link></td>
                <td><Link href={`/sellers/${p.seller.slug}`}>{p.seller.storeName}</Link></td>
                <td><StatusPill status={p.status} /></td>
                <td>{p.featured ? "Yes" : "—"}</td>
                <td>
                  <ToggleFeaturedButton productId={p.id} featured={p.featured} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
