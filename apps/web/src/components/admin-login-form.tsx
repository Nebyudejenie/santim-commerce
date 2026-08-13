"use client";

import { useActionState } from "react";
import { adminLoginAction } from "@/server/actions/auth-actions";
import type { AuthFormState } from "@/server/actions/auth-actions";

const INITIAL_STATE: AuthFormState = { ok: false };

export function AdminLoginForm() {
  const [state, formAction, pending] = useActionState(adminLoginAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      {state.error && <p className="alert alert--error">{state.error}</p>}

      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="form-field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>

      <button type="submit" className="btn btn--primary btn--full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
