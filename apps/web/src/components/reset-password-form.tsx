"use client";

import { useActionState } from "react";
import { resetPasswordAction, type AuthFormState } from "@/server/actions/auth-actions";

const INITIAL_STATE: AuthFormState = { ok: false };

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      {state.error && <p className="alert alert--error">{state.error}</p>}

      <input type="hidden" name="token" value={token} />
      <div className="form-field">
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        <p className="form-hint">At least 10 characters. This will sign you out everywhere else.</p>
      </div>

      <button type="submit" className="btn btn--primary btn--full btn--lg" disabled={pending}>
        {pending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}
