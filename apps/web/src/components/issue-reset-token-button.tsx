"use client";

import { useActionState } from "react";
import { issuePasswordResetTokenAction, type IssueResetTokenState } from "@/server/actions/admin-actions";

const INITIAL_STATE: IssueResetTokenState = { ok: false };

export function IssueResetTokenButton({ userId, userEmail }: { userId: string; userEmail: string }) {
  const [state, formAction, pending] = useActionState(issuePasswordResetTokenAction, INITIAL_STATE);

  if (state.ok && state.resetUrl) {
    return (
      <div className="alert alert--success" style={{ wordBreak: "break-all" }}>
        <p style={{ fontWeight: 600, marginBottom: "var(--space-2)" }}>
          One-time reset link for {userEmail} — valid for 1 hour, shown only this once:
        </p>
        <p style={{ fontFamily: "monospace", fontSize: "var(--text-sm)" }}>{state.resetUrl}</p>
        <p className="form-hint" style={{ marginTop: "var(--space-2)" }}>
          This system does not send email. Copy this link and relay it to the user yourself, through your
          own support channel (ticket reply, phone).
        </p>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(`Issue a password reset link for ${userEmail}? Only do this after verifying the request through a real support channel — this does not notify the user.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      {state.message && !state.ok && <p className="form-hint form-hint--error">{state.message}</p>}
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : "Issue password reset link"}
      </button>
    </form>
  );
}
