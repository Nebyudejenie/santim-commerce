"use client";

import { useActionState, useState } from "react";
import {
  suspendUserAction,
  reinstateUserAction,
  type AdminActionState,
} from "@/server/actions/admin-actions";

const INITIAL_STATE: AdminActionState = { ok: false };

function SuspendForm({ userId, userEmail }: { userId: string; userEmail: string }) {
  const [state, formAction, pending] = useActionState(suspendUserAction, INITIAL_STATE);
  const [open, setOpen] = useState(false);

  if (state.ok) {
    return <p className="form-hint">Account suspended.</p>;
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--secondary btn-sm" onClick={() => setOpen(true)}>
        Suspend account
      </button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(`Suspend ${userEmail}? This signs them out everywhere immediately and blocks any future sign-in until reinstated.`)) {
          e.preventDefault();
        }
      }}
      style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start" }}
    >
      <input type="hidden" name="userId" value={userId} />
      <div>
        <input name="reason" type="text" placeholder="Reason (internal note)" style={{ width: "220px" }} />
        {state.message && !state.ok && <p className="form-hint form-hint--error">{state.message}</p>}
      </div>
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : "Confirm suspend"}
      </button>
    </form>
  );
}

function ReinstateForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(reinstateUserAction, INITIAL_STATE);

  if (state.ok) {
    return <p className="form-hint">Account reinstated.</p>;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="userId" value={userId} />
      {state.message && !state.ok && <p className="form-hint form-hint--error">{state.message}</p>}
      <button type="submit" className="btn btn--primary btn-sm" disabled={pending}>
        {pending ? "…" : "Reinstate account"}
      </button>
    </form>
  );
}

export function SuspendUserButton({
  userId,
  userEmail,
  suspended,
}: {
  userId: string;
  userEmail: string;
  suspended: boolean;
}) {
  return suspended ? <ReinstateForm userId={userId} /> : <SuspendForm userId={userId} userEmail={userEmail} />;
}
