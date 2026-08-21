"use client";

import { useActionState } from "react";
import { answerQuestionAction, type ProductQAActionState } from "@/server/actions/product-qa-actions";

const INITIAL_STATE: ProductQAActionState = { ok: false };

export function AnswerQuestionForm({ questionId, productSlug }: { questionId: string; productSlug: string }) {
  const [state, formAction, pending] = useActionState(answerQuestionAction, INITIAL_STATE);

  if (state.ok) {
    return <p className="form-hint">{state.message}</p>;
  }

  return (
    <form action={formAction} className="form-field" style={{ marginTop: "var(--space-2)" }}>
      <input type="hidden" name="questionId" value={questionId} />
      <input type="hidden" name="productSlug" value={productSlug} />
      <textarea name="answer" rows={2} minLength={3} maxLength={2000} required placeholder="Write your reply…" />
      {state.message && <p className="form-hint form-hint--error">{state.message}</p>}
      <button type="submit" className="btn btn--primary btn-sm" disabled={pending} style={{ marginTop: "var(--space-2)" }}>
        {pending ? "Posting…" : "Post reply"}
      </button>
    </form>
  );
}
