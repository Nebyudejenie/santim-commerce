"use client";

import { useActionState } from "react";
import { hideQuestionAction, type ProductQAActionState } from "@/server/actions/product-qa-actions";

const INITIAL_STATE: ProductQAActionState = { ok: false };

export function HideQuestionButton({ questionId, productSlug }: { questionId: string; productSlug: string }) {
  const [state, formAction, pending] = useActionState(hideQuestionAction, INITIAL_STATE);

  if (state.ok) {
    return <p className="form-hint">{state.message}</p>;
  }

  return (
    <form
      action={formAction}
      style={{ display: "inline-block" }}
      onSubmit={(e) => {
        if (!confirm("Remove this question? It will no longer be visible to buyers.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="questionId" value={questionId} />
      <input type="hidden" name="productSlug" value={productSlug} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : "Remove question"}
      </button>
      {state.message && !state.ok && <p className="form-hint form-hint--error">{state.message}</p>}
    </form>
  );
}
