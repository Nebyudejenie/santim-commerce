"use client";

import { useActionState } from "react";
import { createProductAction, type ListingActionState } from "@/server/actions/listing-actions";

const INITIAL_STATE: ListingActionState = { ok: false };

export function CreateProductForm() {
  const [state, formAction, pending] = useActionState(createProductAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      {state.message && <p className="alert alert--error">{state.message}</p>}

      <div className="form-field">
        <label htmlFor="title">Title</label>
        <input id="title" name="title" type="text" required minLength={3} maxLength={200} />
      </div>
      <div className="form-field">
        <label htmlFor="subtitle">Subtitle (optional)</label>
        <input id="subtitle" name="subtitle" type="text" maxLength={200} />
      </div>
      <div className="form-field">
        <label htmlFor="description">Description</label>
        <textarea id="description" name="description" rows={5} required minLength={10} maxLength={4000} />
      </div>
      <div className="form-field">
        <label htmlFor="brand">Brand (optional)</label>
        <input id="brand" name="brand" type="text" maxLength={100} />
      </div>
      <div className="form-field">
        <label htmlFor="imageUrls">Image URLs (one per line, up to 8)</label>
        <textarea id="imageUrls" name="imageUrls" rows={3} placeholder="https://…" />
        <p className="form-hint">
          No file upload yet — paste links to images you already host. The first line becomes the cover image.
        </p>
      </div>

      <div className="section-head" style={{ marginTop: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-lg)" }}>First variant</h2>
      </div>
      <p className="form-hint">Every listing needs at least one buyable variant to be published.</p>

      <div className="form-field">
        <label htmlFor="variantTitle">Variant name</label>
        <input id="variantTitle" name="variantTitle" type="text" placeholder="e.g. Black / M" maxLength={100} />
      </div>
      <div className="form-field">
        <label htmlFor="sku">SKU</label>
        <input id="sku" name="sku" type="text" required maxLength={64} />
      </div>
      <div className="form-field">
        <label htmlFor="priceBirr">Price (ETB)</label>
        <input id="priceBirr" name="priceBirr" type="number" step="0.01" min="0.01" required />
      </div>
      <div className="form-field">
        <label htmlFor="onHand">Stock quantity</label>
        <input id="onHand" name="onHand" type="number" step="1" min="0" required defaultValue={0} />
      </div>

      <button type="submit" className="btn btn--primary btn--full btn--lg" disabled={pending}>
        {pending ? "Creating…" : "Create draft listing"}
      </button>
    </form>
  );
}
