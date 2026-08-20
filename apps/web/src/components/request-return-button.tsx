"use client";

import { useActionState, useState } from "react";
import { requestReturnAction, type ReturnActionState } from "@/server/actions/return-actions";

const INITIAL_STATE: ReturnActionState = { ok: false };

export function RequestReturnButton({ orderLineId, orderNumber }: { orderLineId: string; orderNumber: string }) {
  const [state, formAction, pending] = useActionState(requestReturnAction, INITIAL_STATE);
  const [open, setOpen] = useState(false);

  if (state.ok) {
    return <p style={{ fontSize: "var(--text-xs)", color: "var(--success)" }}>{state.message}</p>;
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--secondary btn-sm" onClick={() => setOpen(true)}>
        Request return
      </button>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="orderLineId" value={orderLineId} />
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <textarea name="reason" placeholder="Why are you returning this item?" required minLength={10} rows={2} style={{ width: "100%", marginBottom: "var(--space-2)" }} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "Submitting…" : "Submit request"}
      </button>
      {state.message && !state.ok && (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{state.message}</p>
      )}
    </form>
  );
}
