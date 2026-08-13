"use client";

import { useActionState } from "react";
import { registerAction, type AuthFormState } from "@/server/actions/auth-actions";

const INITIAL_STATE: AuthFormState = { ok: false };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      {state.error && <p className="alert alert--error">{state.error}</p>}

      <div className="form-field">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" type="text" autoComplete="name" />
      </div>
      <div className="form-field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="form-field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        <p className="form-hint">At least 10 characters.</p>
      </div>

      <button type="submit" className="btn btn--primary btn--full btn--lg" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
