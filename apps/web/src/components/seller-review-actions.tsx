"use client";

import { useActionState, useState } from "react";
import {
  approveSellerAction,
  rejectSellerAction,
  suspendSellerAction,
  type SellerActionState,
} from "@/server/actions/seller-actions";

const INITIAL_STATE: SellerActionState = { ok: false };

function ApproveButton({ sellerId }: { sellerId: string }) {
  const [state, formAction, pending] = useActionState(approveSellerAction, INITIAL_STATE);
  return (
    <form action={formAction} style={{ display: "inline-block" }}>
      <input type="hidden" name="sellerId" value={sellerId} />
      <button type="submit" className="btn btn--primary btn-sm" disabled={pending}>
        {pending ? "Approving…" : "Approve"}
      </button>
      {state.message && !state.ok && (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{state.message}</p>
      )}
    </form>
  );
}

function RejectButton({ sellerId }: { sellerId: string }) {
  const [state, formAction, pending] = useActionState(rejectSellerAction, INITIAL_STATE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn--secondary btn-sm" onClick={() => setOpen(true)}>
        Reject
      </button>
    );
  }

  return (
    <form action={formAction} style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
      <input type="hidden" name="sellerId" value={sellerId} />
      <input name="reason" type="text" placeholder="Reason" required style={{ width: "160px" }} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : "Confirm"}
      </button>
      {state.message && !state.ok && (
        <span style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{state.message}</span>
      )}
    </form>
  );
}

function SuspendButton({ sellerId }: { sellerId: string }) {
  const [state, formAction, pending] = useActionState(suspendSellerAction, INITIAL_STATE);
  return (
    <form action={formAction} style={{ display: "inline-block" }}>
      <input type="hidden" name="sellerId" value={sellerId} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "Suspending…" : "Suspend"}
      </button>
      {state.message && !state.ok && (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{state.message}</p>
      )}
    </form>
  );
}

/** Only the buttons legal for the seller's CURRENT status — mirrors
 * seller-state-machine.ts's own transition table, so the UI never offers
 * an action the server would reject anyway. */
export function SellerReviewActions({ sellerId, status }: { sellerId: string; status: string }) {
  if (status === "PENDING") {
    return (
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <ApproveButton sellerId={sellerId} />
        <RejectButton sellerId={sellerId} />
      </div>
    );
  }
  if (status === "APPROVED") {
    return <SuspendButton sellerId={sellerId} />;
  }
  if (status === "SUSPENDED") {
    return <ApproveButton sellerId={sellerId} />;
  }
  return null; // REJECTED is terminal — nothing to offer
}
