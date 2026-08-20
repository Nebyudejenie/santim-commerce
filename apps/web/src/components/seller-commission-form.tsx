"use client";

import { useActionState } from "react";
import { setSellerCommissionAction, type SellerActionState } from "@/server/actions/seller-actions";

const INITIAL_STATE: SellerActionState = { ok: false };

export function SellerCommissionForm({ sellerId, commissionBps }: { sellerId: string; commissionBps: number }) {
  const [state, formAction, pending] = useActionState(setSellerCommissionAction, INITIAL_STATE);

  return (
    <form action={formAction} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <input type="hidden" name="sellerId" value={sellerId} />
      <input
        name="commissionPercent"
        type="number"
        step="0.01"
        min="0"
        max="100"
        defaultValue={(commissionBps / 100).toFixed(2)}
        style={{ width: "70px" }}
        aria-label="Commission percentage"
      />
      <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>%</span>
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : "Save"}
      </button>
      {state.message && (
        <span style={{ fontSize: "var(--text-xs)", color: state.ok ? "var(--success)" : "var(--danger)" }}>
          {state.message}
        </span>
      )}
    </form>
  );
}
