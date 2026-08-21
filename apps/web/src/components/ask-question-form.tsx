"use client";

import { useActionState, useEffect, useRef } from "react";
import { askQuestionAction, type ProductQAActionState } from "@/server/actions/product-qa-actions";

const INITIAL_STATE: ProductQAActionState = { ok: false };

export function AskQuestionForm({ productId, productSlug }: { productId: string; productSlug: string }) {
  const [state, formAction, pending] = useActionState(askQuestionAction, INITIAL_STATE);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form action={formAction} ref={formRef} className="form-field">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="productSlug" value={productSlug} />
      <label htmlFor="question">Ask a question</label>
      <textarea id="question" name="question" rows={2} minLength={5} maxLength={1000} required placeholder="Does this come in other colors?" />
      {state.message && (
        <p className={state.ok ? "form-hint" : "form-hint form-hint--error"}>{state.message}</p>
      )}
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending} style={{ marginTop: "var(--space-2)" }}>
        {pending ? "Posting…" : "Post question"}
      </button>
    </form>
  );
}
