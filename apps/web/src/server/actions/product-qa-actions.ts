"use server";

/**
 * Product Q&A mutations — every action checks its own authorization, same
 * in-action-auth discipline as every other action in this codebase.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "../auth/guard.js";
import { requireApprovedSeller, SellerError } from "../sellers/seller-service.js";
import { answerQuestion, askQuestion, hideQuestion, ProductQAError } from "../reviews/product-qa-service.js";
import { logger } from "../observability/logger.js";

export interface ProductQAActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function askQuestionAction(
  _prev: ProductQAActionState,
  formData: FormData,
): Promise<ProductQAActionState> {
  const user = await requireUser();
  const productId = String(formData.get("productId") ?? "");
  const productSlug = String(formData.get("productSlug") ?? "");
  const question = String(formData.get("question") ?? "");

  try {
    await askQuestion(user.id, productId, question);
  } catch (error) {
    if (error instanceof ProductQAError) return { ok: false, message: error.message };
    logger.error("product_qa.ask_action_failed", { userId: user.id, productId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (productSlug) revalidatePath(`/products/${productSlug}`);
  return { ok: true, message: "Your question was posted." };
}

/** Same pattern as coupon-actions.ts's sellerIdOrState — resolves to a real
 * seller id, or an error state if the caller isn't a signed-in, approved
 * seller. */
async function sellerIdOrState(): Promise<string | ProductQAActionState> {
  const user = await requireUser();
  try {
    const seller = await requireApprovedSeller(user.id);
    return seller.id;
  } catch (error) {
    return { ok: false, message: error instanceof SellerError ? error.message : "Not authorized." };
  }
}

export async function answerQuestionAction(
  _prev: ProductQAActionState,
  formData: FormData,
): Promise<ProductQAActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const questionId = String(formData.get("questionId") ?? "");
  const answer = String(formData.get("answer") ?? "");
  const productSlug = String(formData.get("productSlug") ?? "");

  try {
    await answerQuestion(sellerId, questionId, answer);
  } catch (error) {
    if (error instanceof ProductQAError) return { ok: false, message: error.message };
    logger.error("product_qa.answer_action_failed", { sellerId, questionId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (productSlug) revalidatePath(`/products/${productSlug}`);
  revalidatePath("/sell/questions");
  return { ok: true, message: "Your answer was posted." };
}

export async function hideQuestionAction(
  _prev: ProductQAActionState,
  formData: FormData,
): Promise<ProductQAActionState> {
  const sellerId = await sellerIdOrState();
  if (typeof sellerId !== "string") return sellerId;

  const questionId = String(formData.get("questionId") ?? "");
  const productSlug = String(formData.get("productSlug") ?? "");

  try {
    await hideQuestion(sellerId, questionId);
  } catch (error) {
    if (error instanceof ProductQAError) return { ok: false, message: error.message };
    logger.error("product_qa.hide_action_failed", { sellerId, questionId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (productSlug) revalidatePath(`/products/${productSlug}`);
  revalidatePath("/sell/questions");
  return { ok: true, message: "Question removed." };
}
