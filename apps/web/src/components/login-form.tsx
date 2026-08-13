"use client";

import { useActionState } from "react";
import { loginAction, type AuthFormState } from "@/server/actions/auth-actions";

const INITIAL_STATE: AuthFormState = { ok: false };

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      <input type="hidden" name="redirectTo" value={redirectTo ?? "/account"} />
      {state.error && <p className="alert alert--error">{state.error}</p>}

      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="form-field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>

      <button type="submit" className="btn btn--primary btn--full btn--lg" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
