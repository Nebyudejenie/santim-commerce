"use client";

import { useActionState } from "react";
import { hideReviewAction, unhideReviewAction, type ReviewActionState } from "@/server/actions/review-actions";

const INITIAL_STATE: ReviewActionState = { ok: false };

export function ReviewModerationActions({ reviewId, status }: { reviewId: string; status: string }) {
  const [hideState, hideAction, hidePending] = useActionState(hideReviewAction, INITIAL_STATE);
  const [unhideState, unhideAction, unhidePending] = useActionState(unhideReviewAction, INITIAL_STATE);

  if (status === "HIDDEN") {
    return (
      <form action={unhideAction}>
        <input type="hidden" name="reviewId" value={reviewId} />
        <button type="submit" className="btn btn--primary btn-sm" disabled={unhidePending}>
          {unhidePending ? "…" : "Restore"}
        </button>
        {unhideState.message && !unhideState.ok && (
          <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{unhideState.message}</p>
        )}
      </form>
    );
  }

  return (
    <form action={hideAction}>
      <input type="hidden" name="reviewId" value={reviewId} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={hidePending}>
        {hidePending ? "…" : "Hide"}
      </button>
      {hideState.message && !hideState.ok && (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{hideState.message}</p>
      )}
    </form>
  );
}
