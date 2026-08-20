"use client";

import { useActionState } from "react";
import { createReviewAction, type ReviewActionState } from "@/server/actions/review-actions";

const INITIAL_STATE: ReviewActionState = { ok: false };

export function ReviewForm({ productId, productSlug }: { productId: string; productSlug: string }) {
  const [state, formAction, pending] = useActionState(createReviewAction, INITIAL_STATE);

  if (state.ok) {
    return <p className="alert alert--success">{state.message}</p>;
  }

  return (
    <form action={formAction} style={{ marginTop: "var(--space-5)" }}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="productSlug" value={productSlug} />
      {state.message && <p className="alert alert--error">{state.message}</p>}

      <div className="form-field">
        <label htmlFor="rating">Rating</label>
        <select id="rating" name="rating" required defaultValue="5">
          <option value="5">5 — Excellent</option>
          <option value="4">4 — Good</option>
          <option value="3">3 — Average</option>
          <option value="2">2 — Poor</option>
          <option value="1">1 — Terrible</option>
        </select>
      </div>
      <div className="form-field">
        <label htmlFor="title">Title (optional)</label>
        <input id="title" name="title" type="text" maxLength={120} />
      </div>
      <div className="form-field">
        <label htmlFor="body">Your review</label>
        <textarea id="body" name="body" rows={4} required minLength={10} maxLength={2000} />
      </div>

      <button type="submit" className="btn btn--primary" disabled={pending}>
        {pending ? "Submitting…" : "Submit review"}
      </button>
    </form>
  );
}
