"use client";

import { useActionState } from "react";
import { toggleCouponActiveAction, type CouponAdminActionState } from "@/server/actions/coupon-actions";

const INITIAL_STATE: CouponAdminActionState = { ok: false };

export function ToggleCouponActiveButton({ couponId, active }: { couponId: string; active: boolean }) {
  const [state, formAction, pending] = useActionState(toggleCouponActiveAction, INITIAL_STATE);

  if (state.ok) {
    return <span style={{ fontSize: "var(--text-xs)" }}>{state.message}</span>;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="couponId" value={couponId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : active ? "Deactivate" : "Reactivate"}
      </button>
    </form>
  );
}
