import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { CreateProductForm } from "@/components/create-product-form";

export const metadata: Metadata = { title: "New listing" };
export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  await requireApprovedSellerForPage();

  return (
    <div className="container auth-page">
      <div className="auth-card">
        <h1>New listing</h1>
        <p className="auth-card__subtitle">Starts as a draft — publish it once you&apos;re ready.</p>
        <CreateProductForm />
      </div>
    </div>
  );
}
