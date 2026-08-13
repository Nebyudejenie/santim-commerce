import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug, totalAvailable } from "@/server/catalogue/catalogue-service";
import { AddToCartForm, type VariantOption } from "@/components/add-to-cart-form";

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

  return (
    <div className="container pdp">
      <div className="pdp__gallery">
        {product.images.length > 0 ? (
          product.images.map((image) => (
            <div key={image.id} className="pdp__gallery-image">
              <Image
                src={image.url}
                alt={image.alt}
                width={image.width ?? 1200}
                height={image.height ?? 1500}
                sizes="(min-width: 900px) 50vw, 100vw"
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

        {variants.length > 0 ? (
          <AddToCartForm variants={variants} />
        ) : (
          <p className="alert alert--error">No purchasable options for this product.</p>
        )}

        <p className="pdp__description">{product.description}</p>
      </div>
    </div>
  );
}
