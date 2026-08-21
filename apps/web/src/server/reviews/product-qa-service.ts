/**
 * Product Q&A — the eBay/Amazon "Ask a question" pattern. Deliberately NOT
 * gated on proof-of-purchase the way review-service.ts's reviews are: the
 * whole point is letting someone who hasn't bought yet get a real answer
 * before they do. Any signed-in user may ask; only the product's own
 * seller may answer — ownership-scoped exactly like every other
 * seller-scoped mutation in this codebase (a cross-seller attempt is
 * indistinguishable from "not found").
 *
 * Lives alongside review-service.ts (not its own top-level domain) since
 * both are pre/post-purchase buyer-facing product engagement, reviewed
 * together by the same admin/seller audiences.
 */

import { prisma } from "../db.js";
import { enqueue } from "../outbox.js";

export class ProductQAError extends Error {
  override name = "ProductQAError";
}

export async function askQuestion(userId: string, productId: string, question: string): Promise<void> {
  const trimmed = question.trim();
  if (trimmed.length < 5) {
    throw new ProductQAError("Your question must be at least 5 characters.");
  }

  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) {
    throw new ProductQAError("Product not found.");
  }

  await prisma.productQuestion.create({
    data: { productId, askedByUserId: userId, question: trimmed },
  });
}

/** Only the product's own seller may answer — ownership via the WHERE
 * clause itself. A cross-seller attempt (or a bogus questionId) simply
 * matches zero rows, the same "indistinguishable from not existing"
 * outcome every other ownership-scoped mutation in this codebase produces. */
export async function answerQuestion(sellerId: string, questionId: string, answer: string): Promise<void> {
  const trimmed = answer.trim();
  if (trimmed.length < 3) {
    throw new ProductQAError("Your answer must be at least 3 characters.");
  }

  await prisma.$transaction(async (tx) => {
    const result = await tx.productQuestion.updateMany({
      where: { id: questionId, product: { sellerId } },
      data: { answer: trimmed, answeredAt: new Date(), answeredBySellerId: sellerId },
    });
    if (result.count !== 1) {
      throw new ProductQAError("Question not found.");
    }
    // Side effect through the outbox, never a direct call inside this
    // transaction — see outbox.ts's own comment.
    await enqueue(tx, "question.answered", { questionId });
  });
}

export async function listQuestionsForProduct(productId: string) {
  return prisma.productQuestion.findMany({
    where: { productId },
    orderBy: { createdAt: "desc" },
    include: { askedBy: { select: { name: true, email: true } } },
  });
}

/** The seller console's "needs a reply" queue — every question across all
 * of this seller's products that hasn't been answered yet. */
export async function listUnansweredQuestionsForSeller(sellerId: string) {
  return prisma.productQuestion.findMany({
    where: { product: { sellerId }, answer: null },
    orderBy: { createdAt: "asc" },
    include: { product: { select: { title: true, slug: true } }, askedBy: { select: { name: true, email: true } } },
  });
}
