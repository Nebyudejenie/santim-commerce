"use server";

/**
 * Buyer-seller order messaging actions — every action checks its own
 * authorization, same in-action-auth discipline as every other action in
 * this codebase (see message-service.ts for the ownership-scoped queries
 * these actions wrap).
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "../auth/guard.js";
import { requireApprovedSeller, SellerError } from "../sellers/seller-service.js";
import {
  getOrCreateThreadForBuyer,
  getOrCreateThreadForSeller,
  markThreadReadByBuyer,
  markThreadReadBySeller,
  MessagingError,
  sendBuyerMessage,
  sendSellerMessage,
} from "../messaging/message-service.js";
import { logger } from "../observability/logger.js";

export interface MessageActionState {
  readonly ok: boolean;
  readonly message?: string;
}

/** Bound directly to a plain form (no useActionState) — the button that
 * renders it is only ever shown for a seller the page itself already
 * confirmed is part of this order, so the null branch below is a
 * defensive fallback, not a real user-facing error path. */
export async function openThreadAsBuyerAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderNumber = String(formData.get("orderNumber") ?? "");
  const sellerId = String(formData.get("sellerId") ?? "");

  const thread = await getOrCreateThreadForBuyer(user.id, orderNumber, sellerId);
  redirect(thread ? `/account/messages/${thread.id}` : `/account/orders/${orderNumber}`);
}

export async function openThreadAsSellerAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const orderNumber = String(formData.get("orderNumber") ?? "");

  let sellerId: string;
  try {
    const seller = await requireApprovedSeller(user.id);
    sellerId = seller.id;
  } catch {
    redirect(`/sell/orders/${orderNumber}`);
  }

  const thread = await getOrCreateThreadForSeller(sellerId, orderNumber);
  redirect(thread ? `/sell/messages/${thread.id}` : `/sell/orders/${orderNumber}`);
}

export async function sendBuyerMessageAction(
  _prev: MessageActionState,
  formData: FormData,
): Promise<MessageActionState> {
  const user = await requireUser();
  const threadId = String(formData.get("threadId") ?? "");
  const body = String(formData.get("body") ?? "");

  try {
    await sendBuyerMessage(user.id, threadId, body);
  } catch (error) {
    if (error instanceof MessagingError) return { ok: false, message: error.message };
    logger.error("messaging.buyer_send_failed", { userId: user.id, threadId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/account/messages/${threadId}`);
  return { ok: true };
}

export async function sendSellerMessageAction(
  _prev: MessageActionState,
  formData: FormData,
): Promise<MessageActionState> {
  const user = await requireUser();

  let sellerId: string;
  try {
    const seller = await requireApprovedSeller(user.id);
    sellerId = seller.id;
  } catch (error) {
    return { ok: false, message: error instanceof SellerError ? error.message : "Not authorized." };
  }

  const threadId = String(formData.get("threadId") ?? "");
  const body = String(formData.get("body") ?? "");

  try {
    await sendSellerMessage(sellerId, user.id, threadId, body);
  } catch (error) {
    if (error instanceof MessagingError) return { ok: false, message: error.message };
    logger.error("messaging.seller_send_failed", { sellerId, threadId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/sell/messages/${threadId}`);
  return { ok: true };
}

/** Called directly (not bound to a form) from a client component's
 * mount-effect — see buyer-message-thread.tsx's own comment on why
 * mark-as-read must never happen as a side effect of the page's own GET
 * render (Next.js prefetches links on viewport visibility, which would
 * silently mark a thread read before the user ever opened it). */
export async function markThreadReadAsBuyerAction(threadId: string): Promise<void> {
  const user = await requireUser();
  await markThreadReadByBuyer(user.id, threadId);
}

export async function markThreadReadAsSellerAction(threadId: string): Promise<void> {
  const user = await requireUser();
  const seller = await requireApprovedSeller(user.id).catch(() => null);
  if (!seller) return;
  await markThreadReadBySeller(seller.id, threadId);
}
