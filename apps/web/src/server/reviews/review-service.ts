/**
 * Product reviews: create (verified-purchase-gated), report, moderate,
 * seller response, rating aggregation.
 *
 * VERIFIED PURCHASE IS ENFORCED, NOT COSMETIC: createReview requires a
 * real order line for this exact product, on an order that actually
 * resolved to a real sale (PAID or later — not PENDING_PAYMENT, which
 * might never complete) — the master mandate's own framing of "reviews
 * without eligible purchases" as an abuse vector to prevent, not a nice-
 * to-have badge added after the fact.
 */

import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";

export class ReviewError extends Error {
  override name = "ReviewError";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

const REVIEWABLE_ORDER_STATUSES = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] as const;

export interface CreateReviewInput {
  readonly userId: string;
  readonly productId: string;
  readonly rating: number;
  readonly title?: string;
  readonly body: string;
}

/**
 * The actual enforcement, and the single source of truth for it — both
 * createReview (below) and the PDP's "write a review" prompt call this,
 * so the UI's decision to even show the form can never drift from what
 * the server would actually accept. Finds a real order line for THIS
 * user, THIS product, on an order that actually became a real sale.
 * Ownership is proven via Order.userId — a guest checkout (userId null)
 * has no account to review from, which is the correct outcome, not a gap:
 * you cannot log in later and claim a guest purchase happened under this
 * account without a real linking mechanism this app doesn't have.
 */
export async function findEligibleOrderLine(userId: string, productId: string) {
  return prisma.orderLine.findFirst({
    where: {
      order: { userId, status: { in: [...REVIEWABLE_ORDER_STATUSES] } },
      variant: { productId },
    },
  });
}

export async function hasReviewed(userId: string, productId: string): Promise<boolean> {
  const existing = await prisma.productReview.findUnique({ where: { productId_userId: { productId, userId } } });
  return existing !== null;
}

export async function createReview(input: CreateReviewInput) {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new ReviewError("Rating must be a whole number from 1 to 5.");
  }
  const body = input.body.trim();
  if (body.length < 10) {
    throw new ReviewError("Review must be at least 10 characters.");
  }

  const eligibleLine = await findEligibleOrderLine(input.userId, input.productId);
  if (!eligibleLine) {
    throw new ReviewError("You can only review products from a completed order of your own.");
  }

  try {
    const review = await prisma.productReview.create({
      data: {
        productId: input.productId,
        userId: input.userId,
        orderId: eligibleLine.orderId,
        rating: input.rating,
        title: input.title?.trim() || null,
        body,
      },
    });
    logger.info("review.created", { reviewId: review.id, productId: input.productId, userId: input.userId });
    return review;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ReviewError("You've already reviewed this product.");
    }
    throw error;
  }
}

export async function reportReview(reviewId: string, reportedByUserId: string, reason: string): Promise<void> {
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3) {
    throw new ReviewError("Tell us why you're reporting this review.");
  }

  const review = await prisma.productReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new ReviewError("Review not found.");

  try {
    await prisma.reviewReport.create({
      data: { reviewId, reportedByUserId, reason: trimmedReason },
    });
    logger.info("review.reported", { reviewId, reportedByUserId });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ReviewError("You've already reported this review.");
    }
    throw error;
  }
}

export async function hideReview(reviewId: string, adminUserId: string): Promise<void> {
  const review = await prisma.productReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new ReviewError("Review not found.");

  await prisma.productReview.update({ where: { id: reviewId }, data: { status: "HIDDEN" } });
  logger.info("review.hidden", { reviewId, adminUserId });
}

export async function unhideReview(reviewId: string, adminUserId: string): Promise<void> {
  const review = await prisma.productReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new ReviewError("Review not found.");

  await prisma.productReview.update({ where: { id: reviewId }, data: { status: "PUBLISHED" } });
  logger.info("review.unhidden", { reviewId, adminUserId });
}

/** Ownership checked via the review's product's seller — a seller can only
 * respond to reviews on their OWN products, never another seller's. */
export async function respondToReview(sellerId: string, reviewId: string, response: string): Promise<void> {
  const trimmed = response.trim();
  if (trimmed.length < 3) {
    throw new ReviewError("Response is too short.");
  }

  const review = await prisma.productReview.findUnique({
    where: { id: reviewId },
    include: { product: { select: { sellerId: true } } },
  });
  if (!review || review.product.sellerId !== sellerId) {
    throw new ReviewError("Review not found.");
  }

  await prisma.productReview.update({
    where: { id: reviewId },
    data: { sellerResponse: trimmed, sellerRespondedAt: new Date() },
  });
  logger.info("review.seller_responded", { reviewId, sellerId });
}

export async function listProductReviews(productId: string, take = 50) {
  return prisma.productReview.findMany({
    where: { productId, status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    take,
    include: { user: { select: { name: true, email: true } } },
  });
}

export interface RatingSummary {
  readonly average: number | null;
  readonly count: number;
}

export async function getProductRating(productId: string): Promise<RatingSummary> {
  const result = await prisma.productReview.aggregate({
    where: { productId, status: "PUBLISHED" },
    _avg: { rating: true },
    _count: true,
  });
  return { average: result._avg.rating, count: result._count };
}

/** A seller's aggregate rating — the average of PUBLISHED reviews across
 * every one of their own products (see schema.prisma's own comment on why
 * there's no separate SellerReview model). */
export async function getSellerRating(sellerId: string): Promise<RatingSummary> {
  const result = await prisma.productReview.aggregate({
    where: { status: "PUBLISHED", product: { sellerId } },
    _avg: { rating: true },
    _count: true,
  });
  return { average: result._avg.rating, count: result._count };
}

/** For an admin moderation queue — reviews with at least one report, most-reported first. */
export async function listReportedReviews(take = 50) {
  const reviews = await prisma.productReview.findMany({
    where: { reports: { some: {} } },
    include: {
      reports: { orderBy: { createdAt: "desc" } },
      product: { select: { title: true, slug: true } },
      user: { select: { email: true } },
    },
    orderBy: { updatedAt: "desc" },
    take,
  });
  return reviews.sort((a, b) => b.reports.length - a.reports.length);
}
