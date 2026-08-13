"use client";

import { useActionState } from "react";
import { resettlePaymentAction, type AdminActionState } from "@/server/actions/admin-actions";

const INITIAL_STATE: AdminActionState = { ok: false };

/**
 * The manual escape hatch, in UI form. See admin-actions.ts's module doc —
 * this calls the EXACT SAME `settlePayment` the poller and reconciler call
 * automatically, just triggered by a click. It exists for the case the
 * curriculum's Phase 9 (SRE) calls out explicitly: an on-call engineer
 * looking at a stuck payment who wants to force a fresh check against
 * SantimPay's Transaction Status API right now, instead of waiting for the
 * next scheduled poll.
 */
export function ResettleButton({ merchantTxnId, orderNumber }: { merchantTxnId: string; orderNumber?: string }) {
  const [state, formAction, pending] = useActionState(resettlePaymentAction, INITIAL_STATE);

  return (
    <form action={formAction} style={{ display: "inline-flex", flexDirection: "column", gap: "4px" }}>
      <input type="hidden" name="merchantTxnId" value={merchantTxnId} />
      {orderNumber && <input type="hidden" name="orderNumber" value={orderNumber} />}
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "Checking…" : "Re-check with gateway"}
      </button>
      {state.message && (
        <span style={{ fontSize: "var(--text-xs)", color: state.ok ? "var(--success)" : "var(--danger)" }}>
          {state.message}
        </span>
      )}
    </form>
  );
}
