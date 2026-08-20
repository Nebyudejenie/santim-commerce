"use client";

import { useActionState, useState } from "react";
import { approveReturnAction, rejectReturnAction, type ReturnActionState } from "@/server/actions/return-actions";

const INITIAL_STATE: ReturnActionState = { ok: false };

export function ReturnReviewActions({ returnRequestId }: { returnRequestId: string }) {
  const [approveState, approveAction, approvePending] = useActionState(approveReturnAction, INITIAL_STATE);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectReturnAction, INITIAL_STATE);
  const [rejecting, setRejecting] = useState(false);

  if (approveState.ok) return <span style={{ fontSize: "var(--text-xs)", color: "var(--success)" }}>{approveState.message}</span>;
  if (rejectState.ok) return <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>{rejectState.message}</span>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <form action={approveAction}>
          <input type="hidden" name="returnRequestId" value={returnRequestId} />
          <button type="submit" className="btn btn--primary btn-sm" disabled={approvePending}>
            {approvePending ? "…" : "Approve"}
          </button>
        </form>
        <button type="button" className="btn btn--secondary btn-sm" onClick={() => setRejecting(true)}>
          Reject
        </button>
      </div>
      {rejecting && (
        <form action={rejectAction} style={{ display: "flex", gap: "4px" }}>
          <input type="hidden" name="returnRequestId" value={returnRequestId} />
          <input name="note" type="text" placeholder="Reason" required style={{ width: "160px" }} />
          <button type="submit" className="btn btn--secondary btn-sm" disabled={rejectPending}>
            {rejectPending ? "…" : "Confirm"}
          </button>
        </form>
      )}
      {(approveState.message && !approveState.ok) && (
        <span style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{approveState.message}</span>
      )}
      {(rejectState.message && !rejectState.ok) && (
        <span style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{rejectState.message}</span>
      )}
    </div>
  );
}
