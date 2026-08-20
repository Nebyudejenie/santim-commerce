import { notFound } from "next/navigation";
import Link from "next/link";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { getSellerProduct } from "@/server/catalogue/listing-service";
import { StatusPill } from "@/components/status-pill";
import { EditProductForm } from "@/components/edit-product-form";
import { ListingPublishControls } from "@/components/listing-publish-controls";
import { AddVariantForm, VariantRow } from "@/components/variant-editor";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SellerProductDetailPage({ params }: Props) {
  const { id } = await params;
  const seller = await requireApprovedSellerForPage();
  // getSellerProduct returns null for a product this seller doesn't own —
  // rendered here as an ordinary 404, indistinguishable from the id simply
  // not existing (see listing-service.ts's own comment on why that
  // indistinguishability is deliberate, not an oversight).
  const product = await getSellerProduct(seller.id, id);
  if (!product) notFound();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <p style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/sell/products" style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          &larr; Your listings
        </Link>
      </p>

      <div className="section-head">
        <h2>{product.title}</h2>
        <StatusPill status={product.status} />
      </div>

      <ListingPublishControls productId={product.id} status={product.status} />

      <div style={{ marginTop: "var(--space-6)" }}>
        <EditProductForm product={product} />
      </div>

      <div style={{ marginTop: "var(--space-7)" }}>
        <h3 style={{ marginBottom: "var(--space-3)" }}>Variants</h3>
        {product.variants.map((variant) => (
          <VariantRow key={variant.id} productId={product.id} variant={variant} />
        ))}
        <AddVariantForm productId={product.id} />
      </div>
    </div>
  );
}
