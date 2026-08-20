import { listReportedReviews } from "@/server/reviews/review-service";
import { StatusPill } from "@/components/status-pill";
import { ReviewModerationActions } from "@/components/review-moderation-actions";

export default async function AdminReviewsPage() {
  const reviews = await listReportedReviews();

  return (
    <div>
      <div className="admin-header">
        <h1>Reported reviews</h1>
      </div>

      {reviews.length === 0 ? (
        <p className="empty-note">No reported reviews.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Reviewer</th>
              <th>Rating</th>
              <th>Review</th>
              <th>Reports</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((review) => (
              <tr key={review.id}>
                <td>{review.product.title}</td>
                <td>{review.user.email}</td>
                <td>{review.rating} / 5</td>
                <td style={{ maxWidth: "280px" }}>{review.body}</td>
                <td>
                  {review.reports.map((r) => (
                    <div key={r.id} style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                      {r.reason}
                    </div>
                  ))}
                </td>
                <td><StatusPill status={review.status} /></td>
                <td>
                  <ReviewModerationActions reviewId={review.id} status={review.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
