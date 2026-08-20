"use client";

import { useActionState } from "react";
import {
  adminApproveReturnAction,
  adminRejectReturnAction,
  type ReturnActionState,
} from "@/server/actions/return-actions";

const INITIAL_STATE: ReturnActionState = { ok: false };

export function AdminReturnActions({ returnRequestId }: { returnRequestId: string }) {
  const [approveState, approveAction, approvePending] = useActionState(adminApproveReturnAction, INITIAL_STATE);
  const [rejectState, rejectAction, rejectPending] = useActionState(adminRejectReturnAction, INITIAL_STATE);

  if (approveState.ok || rejectState.ok) {
    return <span style={{ fontSize: "var(--text-xs)" }}>{approveState.message ?? rejectState.message}</span>;
  }

  return (
    <div style={{ display: "flex", gap: "var(--space-2)" }}>
      <form action={approveAction}>
        <input type="hidden" name="returnRequestId" value={returnRequestId} />
        <button type="submit" className="btn btn--primary btn-sm" disabled={approvePending}>
          {approvePending ? "…" : "Approve"}
        </button>
      </form>
      <form action={rejectAction}>
        <input type="hidden" name="returnRequestId" value={returnRequestId} />
        <button type="submit" className="btn btn--secondary btn-sm" disabled={rejectPending}>
          {rejectPending ? "…" : "Reject"}
        </button>
      </form>
    </div>
  );
}
