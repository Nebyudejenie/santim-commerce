"use client";

import { useActionState } from "react";
import { setProductStatusAction, type ListingActionState } from "@/server/actions/listing-actions";

const INITIAL_STATE: ListingActionState = { ok: false };

const NEXT_STATUS: Record<string, { status: string; label: string; className: string }[]> = {
  DRAFT: [{ status: "ACTIVE", label: "Publish", className: "btn--primary" }],
  ACTIVE: [{ status: "ARCHIVED", label: "Unpublish", className: "btn--secondary" }],
  ARCHIVED: [{ status: "ACTIVE", label: "Republish", className: "btn--primary" }],
};

export function ListingPublishControls({ productId, status }: { productId: string; status: string }) {
  const [state, formAction, pending] = useActionState(setProductStatusAction, INITIAL_STATE);
  const options = NEXT_STATUS[status] ?? [];

  return (
    <div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        {options.map((opt) => (
          <form action={formAction} key={opt.status}>
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="status" value={opt.status} />
            <button type="submit" className={`btn ${opt.className} btn-sm`} disabled={pending}>
              {pending ? "…" : opt.label}
            </button>
          </form>
        ))}
      </div>
      {state.message && (
        <p style={{ fontSize: "var(--text-xs)", color: state.ok ? "var(--success)" : "var(--danger)" }}>
          {state.message}
        </p>
      )}
    </div>
  );
}
