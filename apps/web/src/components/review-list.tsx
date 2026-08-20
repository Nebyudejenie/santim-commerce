"use client";

import { useActionState, useState } from "react";
import { reportReviewAction, type ReviewActionState } from "@/server/actions/review-actions";
import { StarRating } from "./star-rating";

const INITIAL_STATE: ReviewActionState = { ok: false };

export interface ReviewData {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  createdAt: Date;
  user: { name: string | null };
  sellerResponse: string | null;
}

function ReportButton({ reviewId }: { reviewId: string }) {
  const [state, formAction, pending] = useActionState(reportReviewAction, INITIAL_STATE);
  const [open, setOpen] = useState(false);

  if (state.ok) return <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>{state.message}</span>;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ fontSize: "var(--text-xs)", color: "var(--fg-faint)", textDecoration: "underline" }}
      >
        Report
      </button>
    );
  }

  return (
    <form action={formAction} style={{ display: "inline-flex", gap: "4px" }}>
      <input type="hidden" name="reviewId" value={reviewId} />
      <input name="reason" type="text" placeholder="Reason" required style={{ width: "140px", fontSize: "var(--text-xs)" }} />
      <button type="submit" disabled={pending} style={{ fontSize: "var(--text-xs)" }}>
        {pending ? "…" : "Send"}
      </button>
    </form>
  );
}

export function ReviewList({ reviews }: { reviews: ReviewData[] }) {
  if (reviews.length === 0) {
    return <p className="empty-note">No reviews yet — be the first.</p>;
  }

  return (
    <div>
      {reviews.map((review) => (
        <div key={review.id} style={{ borderBottom: "1px solid var(--border)", paddingBlock: "var(--space-4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <StarRating rating={review.rating} />
            <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
              {review.createdAt.toISOString().slice(0, 10)}
            </span>
          </div>
          {review.title && <p style={{ fontWeight: 600, marginTop: "var(--space-2)" }}>{review.title}</p>}
          <p style={{ marginTop: "var(--space-2)" }}>{review.body}</p>
          <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)", marginTop: "var(--space-2)" }}>
            {review.user.name ?? "Verified buyer"}
          </p>
          {review.sellerResponse && (
            <div
              style={{
                marginTop: "var(--space-3)",
                padding: "var(--space-3)",
                background: "var(--bg-subtle)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--text-sm)",
              }}
            >
              <strong>Seller response:</strong> {review.sellerResponse}
            </div>
          )}
          <div style={{ marginTop: "var(--space-2)" }}>
            <ReportButton reviewId={review.id} />
          </div>
        </div>
      ))}
    </div>
  );
}
