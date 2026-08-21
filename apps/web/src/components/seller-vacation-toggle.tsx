"use client";

import { useActionState } from "react";
import { setSellerVacationAction, type SellerActionState } from "@/server/actions/seller-actions";

const INITIAL_STATE: SellerActionState = { ok: false };

export function SellerVacationToggle({ onVacation }: { onVacation: boolean }) {
  const [state, formAction, pending] = useActionState(setSellerVacationAction, INITIAL_STATE);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const message = onVacation
          ? "Reopen your store? Your listings will become visible to customers again."
          : "Pause your store? Every listing becomes invisible to customers until you turn this back off.";
        if (!confirm(message)) e.preventDefault();
      }}
    >
      <input type="hidden" name="onVacation" value={onVacation ? "false" : "true"} />
      {state.message && <p className={state.ok ? "form-hint" : "form-hint form-hint--error"}>{state.message}</p>}
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : onVacation ? "Reopen store" : "Pause store (vacation mode)"}
      </button>
    </form>
  );
}
