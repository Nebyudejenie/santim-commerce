"use client";

import { useActionState } from "react";
import { updateProductAction, type ListingActionState } from "@/server/actions/listing-actions";

const INITIAL_STATE: ListingActionState = { ok: false };

interface Props {
  product: {
    id: string;
    title: string;
    subtitle: string | null;
    description: string;
    brand: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
  };
}

export function EditProductForm({ product }: Props) {
  const [state, formAction, pending] = useActionState(updateProductAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={product.id} />
      {state.message && (
        <p className={state.ok ? "alert alert--success" : "alert alert--error"}>{state.message}</p>
      )}

      <div className="form-field">
        <label htmlFor="title">Title</label>
        <input id="title" name="title" type="text" required minLength={3} maxLength={200} defaultValue={product.title} />
      </div>
      <div className="form-field">
        <label htmlFor="subtitle">Subtitle</label>
        <input id="subtitle" name="subtitle" type="text" maxLength={200} defaultValue={product.subtitle ?? ""} />
      </div>
      <div className="form-field">
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" rows={5} required minLength={10} maxLength={4000} defaultValue={product.description} />
      </div>
      <div className="form-field">
        <label htmlFor="brand">Brand</label>
        <input id="brand" name="brand" type="text" maxLength={100} defaultValue={product.brand ?? ""} />
      </div>

      <div className="section-head" style={{ marginTop: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-lg)" }}>Search appearance</h2>
      </div>
      <p className="form-hint">
        What shows up in search engine results. Leave blank to use the title and subtitle above instead.
      </p>
      <div className="form-field">
        <label htmlFor="metaTitle">SEO title</label>
        <input id="metaTitle" name="metaTitle" type="text" maxLength={200} defaultValue={product.metaTitle ?? ""} />
      </div>
      <div className="form-field">
        <label htmlFor="metaDescription">SEO description</label>
        <textarea id="metaDescription" name="metaDescription" rows={2} maxLength={300} defaultValue={product.metaDescription ?? ""} />
      </div>

      <button type="submit" className="btn btn--secondary" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
