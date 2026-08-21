import Link from "next/link";
import type { Metadata } from "next";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { listUnansweredQuestionsForSeller } from "@/server/reviews/product-qa-service";
import { AnswerQuestionForm } from "@/components/answer-question-form";

export const metadata: Metadata = { title: "Your questions" };
export const dynamic = "force-dynamic";

export default async function SellerQuestionsPage() {
  const seller = await requireApprovedSellerForPage();
  const questions = await listUnansweredQuestionsForSeller(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <div className="section-head">
        <h2>{seller.storeName} — questions</h2>
      </div>

      {questions.length === 0 ? (
        <div className="empty-state">
          <h2>No open questions</h2>
          <p>Questions buyers ask on your listings that still need a reply will show up here.</p>
        </div>
      ) : (
        <div>
          {questions.map((q) => (
            <div key={q.id} className="detail-card" style={{ marginBottom: "var(--space-4)" }}>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)", marginBottom: "var(--space-2)" }}>
                <Link href={`/products/${q.product.slug}#questions`}>{q.product.title}</Link>
                {" · "}
                {q.createdAt.toISOString().slice(0, 10)}
              </p>
              <p style={{ fontWeight: 600 }}>{q.question}</p>
              <AnswerQuestionForm questionId={q.id} productSlug={q.product.slug} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
