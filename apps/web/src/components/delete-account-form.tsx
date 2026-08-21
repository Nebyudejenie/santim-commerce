"use client";

import { useActionState } from "react";
import { deleteAccountAction, type AuthFormState } from "@/server/actions/auth-actions";

const INITIAL_STATE: AuthFormState = { ok: false };

export function DeleteAccountForm() {
  const [state, formAction, pending] = useActionState(deleteAccountAction, INITIAL_STATE);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (
          !confirm(
            "Delete your account permanently? This cannot be undone — you will be signed out everywhere and will need a new account to shop or sell again.",
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      {state.error && <p className="alert alert--error">{state.error}</p>}

      <div className="form-field">
        <label htmlFor="deleteCurrentPassword">Current password</label>
        <input id="deleteCurrentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </div>

      <button type="submit" className="btn btn--secondary" disabled={pending} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
        {pending ? "Deleting…" : "Delete my account"}
      </button>
    </form>
  );
}
