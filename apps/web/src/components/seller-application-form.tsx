"use client";

import { useActionState } from "react";
import { applyToBecomeSellerAction, type SellerActionState } from "@/server/actions/seller-actions";

const INITIAL_STATE: SellerActionState = { ok: false };

export function SellerApplicationForm() {
  const [state, formAction, pending] = useActionState(applyToBecomeSellerAction, INITIAL_STATE);

  if (state.ok) {
    return <p className="alert alert--success">{state.message}</p>;
  }

  return (
    <form action={formAction}>
      {state.message && <p className="alert alert--error">{state.message}</p>}

      <div className="form-field">
        <label htmlFor="storeName">Store name</label>
        <input id="storeName" name="storeName" type="text" required minLength={2} maxLength={80} />
      </div>
      <div className="form-field">
        <label htmlFor="description">Tell us about what you sell</label>
        <textarea id="description" name="description" rows={4} maxLength={2000} />
      </div>

      <button type="submit" className="btn btn--primary btn--full btn--lg" disabled={pending}>
        {pending ? "Submitting…" : "Apply to sell"}
      </button>
    </form>
  );
}
