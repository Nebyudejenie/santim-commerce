"use client";

import { useActionState } from "react";
import { updateProductAction, type ListingActionState } from "@/server/actions/listing-actions";

const INITIAL_STATE: ListingActionState = { ok: false };

interface Props {
  product: { id: string; title: string; subtitle: string | null; description: string; brand: string | null };
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

      <button type="submit" className="btn btn--secondary" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
