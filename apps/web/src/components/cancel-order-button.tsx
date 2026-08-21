"use client";

import { useActionState } from "react";
import { cancelOrderAction, type OrderCancellationActionState } from "@/server/actions/order-cancellation-actions";

const INITIAL_STATE: OrderCancellationActionState = { ok: false };

export function CancelOrderButton({ orderNumber }: { orderNumber: string }) {
  const [state, formAction, pending] = useActionState(cancelOrderAction, INITIAL_STATE);

  if (state.ok) {
    return <p className="alert alert--success" style={{ marginTop: "var(--space-4)" }}>{state.message}</p>;
  }

  return (
    <form
      action={formAction}
      style={{ marginTop: "var(--space-4)" }}
      onSubmit={(e) => {
        if (!confirm("Cancel this order? This can't be undone.")) e.preventDefault();
      }}
    >
      <input type="hidden" name="orderNumber" value={orderNumber} />
      {state.message && !state.ok && <p className="form-hint form-hint--error">{state.message}</p>}
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel order"}
      </button>
    </form>
  );
}
