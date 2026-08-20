"use client";

import { useActionState } from "react";
import { deleteAddressAction, type AddressActionState } from "@/server/actions/address-actions";

const INITIAL_STATE: AddressActionState = { ok: false };

export function DeleteAddressButton({ addressId }: { addressId: string }) {
  const [state, formAction, pending] = useActionState(deleteAddressAction, INITIAL_STATE);

  if (state.ok) return null;

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm("Remove this address?")) e.preventDefault();
      }}
    >
      <input type="hidden" name="addressId" value={addressId} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : "Remove"}
      </button>
      {state.message && !state.ok && (
        <span style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}>{state.message}</span>
      )}
    </form>
  );
}
