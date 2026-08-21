/**
 * Buyer-seller order messaging — the master mandate's own "buyer-seller
 * messaging" line item, confirmed absent and deliberately deferred
 * earlier (see PROJECT-EXECUTION-STATE.md) as its own multi-part feature
 * rather than half-built alongside admin content moderation. Scoped to a
 * specific (order, seller) pair, not a general "message this seller from
 * anywhere" inbox — this keeps authorization trivial (buyer must own the
 * order; seller must have a real line in it) and matches the real
 * post-purchase use case a marketplace needs most ("where's my package",
 * "can I get a different size"). Pre-purchase questions already have
 * their own, public, ProductQuestion Q&A (product-qa-service.ts) — this
 * is not a replacement for that.
 *
 * A guest order (Order.userId === null) has no account to open a thread
 * with — same reasoning notification-service.ts already documents for
 * its own guest-order skip.
 */

import { prisma } from "../db.js";
import { enqueue } from "../outbox.js";

export class MessagingError extends Error {
  override name = "MessagingError";
}

const MAX_MESSAGE_LENGTH = 4000;

function validateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length < 1) throw new MessagingError("Message cannot be empty.");
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new MessagingError(`Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

/**
 * Opens (or returns) the one thread for this (order, seller) pair, from
 * the BUYER's side. `sellerId` must belong to a real line in THIS order —
 * a buyer can't open a thread with an unrelated seller by guessing an id,
 * the same ownership-via-WHERE discipline as everywhere else in this
 * codebase. Returns null (not a throw) for a non-owned order or an
 * unrelated seller — indistinguishable, matching this codebase's own
 * established convention.
 */
export async function getOrCreateThreadForBuyer(
  userId: string,
  orderNumber: string,
  sellerId: string,
): Promise<{ id: string } | null> {
  const order = await prisma.order.findFirst({
    where: { orderNumber, userId, lines: { some: { sellerId } } },
    select: { id: true },
  });
  if (!order) return null;

  return prisma.messageThread.upsert({
    where: { orderId_sellerId: { orderId: order.id, sellerId } },
    create: { orderId: order.id, sellerId, buyerUserId: userId, buyerLastReadAt: new Date() },
    update: {},
    select: { id: true },
  });
}

/**
 * Same as above from the SELLER's side. Refuses a guest order (no
 * userId) — there is no buyer account to open a thread with.
 */
export async function getOrCreateThreadForSeller(
  sellerId: string,
  orderNumber: string,
): Promise<{ id: string } | null> {
  const order = await prisma.order.findFirst({
    where: { orderNumber, lines: { some: { sellerId } } },
    select: { id: true, userId: true },
  });
  if (!order || !order.userId) return null;

  return prisma.messageThread.upsert({
    where: { orderId_sellerId: { orderId: order.id, sellerId } },
    create: { orderId: order.id, sellerId, buyerUserId: order.userId, sellerLastReadAt: new Date() },
    update: {},
    select: { id: true },
  });
}

/** Ownership via the WHERE clause itself: a threadId that isn't this
 * buyer's own simply matches zero rows, same "not found" outcome a
 * cross-user attempt gets everywhere else in this codebase. */
export async function sendBuyerMessage(userId: string, threadId: string, body: string): Promise<void> {
  const trimmed = validateBody(body);

  await prisma.$transaction(async (tx) => {
    const result = await tx.messageThread.updateMany({
      where: { id: threadId, buyerUserId: userId },
      // The sender has implicitly "read" up to their own message.
      data: { buyerLastReadAt: new Date() },
    });
    if (result.count !== 1) throw new MessagingError("Conversation not found.");

    const message = await tx.message.create({ data: { threadId, senderUserId: userId, body: trimmed } });
    // Side effect through the outbox, never a direct call inside this
    // transaction — see outbox.ts's own comment.
    await enqueue(tx, "message.sent", { messageId: message.id });
  });
}

export async function sendSellerMessage(
  sellerId: string,
  senderUserId: string,
  threadId: string,
  body: string,
): Promise<void> {
  const trimmed = validateBody(body);

  await prisma.$transaction(async (tx) => {
    const result = await tx.messageThread.updateMany({
      where: { id: threadId, sellerId },
      data: { sellerLastReadAt: new Date() },
    });
    if (result.count !== 1) throw new MessagingError("Conversation not found.");

    const message = await tx.message.create({ data: { threadId, senderUserId, body: trimmed } });
    await enqueue(tx, "message.sent", { messageId: message.id });
  });
}

export async function getThreadForBuyer(userId: string, threadId: string) {
  return prisma.messageThread.findFirst({
    where: { id: threadId, buyerUserId: userId },
    include: {
      order: { select: { orderNumber: true } },
      seller: { select: { storeName: true, slug: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function getThreadForSeller(sellerId: string, threadId: string) {
  return prisma.messageThread.findFirst({
    where: { id: threadId, sellerId },
    include: {
      order: { select: { orderNumber: true } },
      buyer: { select: { name: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function markThreadReadByBuyer(userId: string, threadId: string): Promise<void> {
  await prisma.messageThread.updateMany({
    where: { id: threadId, buyerUserId: userId },
    data: { buyerLastReadAt: new Date() },
  });
}

export async function markThreadReadBySeller(sellerId: string, threadId: string): Promise<void> {
  await prisma.messageThread.updateMany({
    where: { id: threadId, sellerId },
    data: { sellerLastReadAt: new Date() },
  });
}

function isUnreadForBuyer(thread: {
  buyerUserId: string;
  buyerLastReadAt: Date | null;
  messages: { senderUserId: string; createdAt: Date }[];
}): boolean {
  const last = thread.messages[0];
  if (!last) return false;
  const fromSeller = last.senderUserId !== thread.buyerUserId;
  return fromSeller && (!thread.buyerLastReadAt || last.createdAt > thread.buyerLastReadAt);
}

function isUnreadForSeller(thread: {
  buyerUserId: string;
  sellerLastReadAt: Date | null;
  messages: { senderUserId: string; createdAt: Date }[];
}): boolean {
  const last = thread.messages[0];
  if (!last) return false;
  const fromBuyer = last.senderUserId === thread.buyerUserId;
  return fromBuyer && (!thread.sellerLastReadAt || last.createdAt > thread.sellerLastReadAt);
}

/** The buyer's own message inbox — every thread they're party to, most
 * recently active first. Sorted by each thread's latest MESSAGE time,
 * computed here, deliberately never by `updatedAt` — see that column's
 * own schema comment on why a pure read-mark would otherwise reorder it. */
export async function listThreadsForBuyer(userId: string) {
  const threads = await prisma.messageThread.findMany({
    where: { buyerUserId: userId },
    include: {
      order: { select: { orderNumber: true } },
      seller: { select: { storeName: true, slug: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return threads
    .map((thread) => ({
      ...thread,
      unread: isUnreadForBuyer(thread),
      lastMessageAt: thread.messages[0]?.createdAt ?? thread.createdAt,
    }))
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
}

export async function listThreadsForSeller(sellerId: string) {
  const threads = await prisma.messageThread.findMany({
    where: { sellerId },
    include: {
      order: { select: { orderNumber: true } },
      buyer: { select: { name: true, email: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return threads
    .map((thread) => ({
      ...thread,
      unread: isUnreadForSeller(thread),
      lastMessageAt: thread.messages[0]?.createdAt ?? thread.createdAt,
    }))
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
}
