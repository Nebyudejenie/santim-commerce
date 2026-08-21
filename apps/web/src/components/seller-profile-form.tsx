"use client";

import { useActionState } from "react";
import { updateSellerProfileAction, type SellerActionState } from "@/server/actions/seller-actions";

const INITIAL_STATE: SellerActionState = { ok: false };

interface Props {
  storeName: string;
  description: string | null;
  logoUrl: string | null;
}

export function SellerProfileForm({ storeName, description, logoUrl }: Props) {
  const [state, formAction, pending] = useActionState(updateSellerProfileAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      {state.message && (
        <p className={state.ok ? "alert alert--success" : "alert alert--error"}>{state.message}</p>
      )}

      <div className="form-field">
        <label htmlFor="storeName">Store name</label>
        <input id="storeName" name="storeName" type="text" defaultValue={storeName} required minLength={2} maxLength={80} />
      </div>
      <div className="form-field">
        <label htmlFor="description">About your store</label>
        <textarea id="description" name="description" rows={4} maxLength={2000} defaultValue={description ?? ""} />
      </div>
      <div className="form-field">
        <label htmlFor="logoUrl">Logo image URL</label>
        <input id="logoUrl" name="logoUrl" type="text" defaultValue={logoUrl ?? ""} placeholder="https://…" />
        <p className="form-hint">Paste a link to an image. Leave blank to remove your logo.</p>
      </div>

      <button type="submit" className="btn btn--primary" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
