"use server";

/**
 * Review mutations — checks its own authorization via requireUser/
 * requireApprovedSeller, same in-action-auth discipline as every other
 * action added this session.
 */

import { revalidatePath } from "next/cache";
import { requireRole, requireUser } from "../auth/guard.js";
import { requireApprovedSeller, SellerError } from "../sellers/seller-service.js";
import {
  createReview,
  hideReview,
  reportReview,
  respondToReview,
  ReviewError,
  unhideReview,
} from "../reviews/review-service.js";
import { logger } from "../observability/logger.js";

export interface ReviewActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function createReviewAction(
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const user = await requireUser();
  const productId = String(formData.get("productId") ?? "");
  const productSlug = String(formData.get("productSlug") ?? "");
  const rating = Number(formData.get("rating") ?? "");
  const title = String(formData.get("title") ?? "");
  const body = String(formData.get("body") ?? "");

  try {
    await createReview({ userId: user.id, productId, rating, title, body });
  } catch (error) {
    if (error instanceof ReviewError) return { ok: false, message: error.message };
    logger.error("review.create_action_failed", { productId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong submitting your review. Please try again." };
  }

  if (productSlug) revalidatePath(`/products/${productSlug}`);
  return { ok: true, message: "Thanks for your review!" };
}

export async function reportReviewAction(
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const user = await requireUser();
  const reviewId = String(formData.get("reviewId") ?? "");
  const reason = String(formData.get("reason") ?? "");

  try {
    await reportReview(reviewId, user.id, reason);
  } catch (error) {
    if (error instanceof ReviewError) return { ok: false, message: error.message };
    logger.error("review.report_action_failed", { reviewId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  return { ok: true, message: "Thanks — we'll take a look." };
}

export async function respondToReviewAction(
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const user = await requireUser();
  const reviewId = String(formData.get("reviewId") ?? "");
  const productSlug = String(formData.get("productSlug") ?? "");
  const response = String(formData.get("response") ?? "");

  let sellerId: string;
  try {
    const seller = await requireApprovedSeller(user.id);
    sellerId = seller.id;
  } catch (error) {
    return { ok: false, message: error instanceof SellerError ? error.message : "Not authorized." };
  }

  try {
    await respondToReview(sellerId, reviewId, response);
  } catch (error) {
    if (error instanceof ReviewError) return { ok: false, message: error.message };
    logger.error("review.respond_action_failed", { reviewId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (productSlug) revalidatePath(`/products/${productSlug}`);
  return { ok: true, message: "Response posted." };
}

export async function hideReviewAction(
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const admin = await requireRole("STAFF");
  const reviewId = String(formData.get("reviewId") ?? "");

  try {
    await hideReview(reviewId, admin.id);
  } catch (error) {
    if (error instanceof ReviewError) return { ok: false, message: error.message };
    logger.error("review.hide_action_failed", { reviewId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/admin/reviews");
  return { ok: true, message: "Review hidden." };
}

export async function unhideReviewAction(
  _prev: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const admin = await requireRole("STAFF");
  const reviewId = String(formData.get("reviewId") ?? "");

  try {
    await unhideReview(reviewId, admin.id);
  } catch (error) {
    if (error instanceof ReviewError) return { ok: false, message: error.message };
    logger.error("review.unhide_action_failed", { reviewId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/admin/reviews");
  return { ok: true, message: "Review restored." };
}
