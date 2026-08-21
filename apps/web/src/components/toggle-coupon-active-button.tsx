"use client";

import { useActionState } from "react";
import { toggleCouponActiveAction, type CouponAdminActionState } from "@/server/actions/coupon-actions";

const INITIAL_STATE: CouponAdminActionState = { ok: false };

type ToggleAction = (prev: CouponAdminActionState, formData: FormData) => Promise<CouponAdminActionState>;

export function ToggleCouponActiveButton({
  couponId,
  active,
  action = toggleCouponActiveAction,
}: {
  couponId: string;
  active: boolean;
  action?: ToggleAction;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

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
