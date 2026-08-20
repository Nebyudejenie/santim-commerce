"use client";

import { useActionState } from "react";
import {
  markLineFulfilledAction,
  markLineUnfulfilledAction,
  type FulfilmentActionState,
} from "@/server/actions/fulfilment-actions";

const INITIAL_STATE: FulfilmentActionState = { ok: false };

interface Props {
  orderLineId: string;
  orderNumber: string;
  status: string;
}

export function FulfilmentToggle({ orderLineId, orderNumber, status }: Props) {
  const [fulfillState, fulfillAction, fulfillPending] = useActionState(markLineFulfilledAction, INITIAL_STATE);
  const [unfulfillState, unfulfillAction, unfulfillPending] = useActionState(markLineUnfulfilledAction, INITIAL_STATE);

  if (status === "FULFILLED") {
    return (
      <form action={unfulfillAction}>
        <input type="hidden" name="orderLineId" value={orderLineId} />
        <input type="hidden" name="orderNumber" value={orderNumber} />
        <button type="submit" className="btn btn--secondary btn-sm" disabled={unfulfillPending}>
          {unfulfillPending ? "…" : "Undo — mark unshipped"}
        </button>
        {unfulfillState.message && !unfulfillState.ok && (
          <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{unfulfillState.message}</p>
        )}
      </form>
    );
  }

  return (
    <form action={fulfillAction}>
      <input type="hidden" name="orderLineId" value={orderLineId} />
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <button type="submit" className="btn btn--primary btn-sm" disabled={fulfillPending}>
        {fulfillPending ? "…" : "Mark shipped"}
      </button>
      {fulfillState.message && !fulfillState.ok && (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{fulfillState.message}</p>
      )}
    </form>
  );
}
