"use client";

import { useActionState } from "react";
import { changePasswordAction, type AuthFormState } from "@/server/actions/auth-actions";

const INITIAL_STATE: AuthFormState = { ok: false };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      {state.error && <p className="alert alert--error">{state.error}</p>}

      <div className="form-field">
        <label htmlFor="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </div>
      <div className="form-field">
        <label htmlFor="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={10} />
        <p className="form-hint">At least 10 characters. This will sign you out everywhere, including here.</p>
      </div>

      <button type="submit" className="btn btn--primary" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
