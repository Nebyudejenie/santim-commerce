"use client";

import { useActionState } from "react";
import { recordSellerPayoutAction, type AdminActionState } from "@/server/actions/admin-actions";

const INITIAL_STATE: AdminActionState = { ok: false };

export function RecordPayoutButton({ sellerId, storeName, payableBirr }: { sellerId: string; storeName: string; payableBirr: string }) {
  const [state, formAction, pending] = useActionState(recordSellerPayoutAction, INITIAL_STATE);

  if (state.ok) {
    return <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>{state.message}</span>;
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (
          !confirm(
            `Record a payout of ${payableBirr} ETB to ${storeName}? Only confirm this AFTER you've actually sent the money outside this system — this does not send any payment itself.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="sellerId" value={sellerId} />
      {state.message && !state.ok && <p className="form-hint form-hint--error">{state.message}</p>}
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : "Record payout"}
      </button>
    </form>
  );
}
