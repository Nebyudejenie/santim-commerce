/**
 * Seller lifecycle: apply, review (approve/reject), suspend/reinstate.
 *
 * The verification/KYC workflow here is deliberately simple — an admin
 * approves or rejects, no automated identity check — matching this app's
 * existing admin-login pattern (real session-based auth, no third-party
 * KYC integration to fake). A real deployment would slot document upload
 * and a KYC provider in at `applyToBecomeSeller`'s call site, not rewrite
 * the state machine below.
 */

import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";
import type { SellerStatus } from "@prisma/client";
import { canTransitionSeller } from "./seller-state-machine.js";

export class SellerError extends Error {
  override name = "SellerError";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export interface ApplyToBecomeSellerInput {
  readonly userId: string;
  readonly storeName: string;
  readonly description?: string;
}

/**
 * Only valid transition INTO the seller system. One store per user (see
 * schema.prisma's own comment on Seller.ownerId) — a second application
 * from someone who already has a store, in any status, is rejected with a
 * specific message rather than silently creating a duplicate.
 */
export async function applyToBecomeSeller(input: ApplyToBecomeSellerInput) {
  const storeName = input.storeName.trim();
  if (storeName.length < 2) {
    throw new SellerError("Store name must be at least 2 characters.");
  }

  const existing = await prisma.seller.findUnique({ where: { ownerId: input.userId } });
  if (existing) {
    throw new SellerError(
      existing.status === "REJECTED"
        ? "Your previous seller application was declined. Contact support to reapply."
        : "You already have a seller account.",
    );
  }

  const baseSlug = slugify(storeName) || "store";
  // Collision-safe without a retry loop: try the plain slug, then
  // increasingly specific suffixes. Store creation is a rare, human-paced
  // action (not a hot path like checkout), so a small bounded loop here is
  // the right tool — reservation.ts's atomic-UPDATE pattern is for
  // high-concurrency paths, this isn't one.
  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    try {
      const seller = await prisma.seller.create({
        data: {
          ownerId: input.userId,
          storeName,
          slug,
          description: input.description?.trim() || null,
          status: "PENDING",
        },
      });
      logger.info("seller.applied", { sellerId: seller.id, userId: input.userId });
      return seller;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const conflict = await prisma.seller.findUnique({ where: { ownerId: input.userId } });
        // The unique violation was on ownerId (a genuine second application,
        // possibly a race against itself), not on slug — stop retrying.
        if (conflict) {
          throw new SellerError("You already have a seller account.");
        }
        continue; // was a slug collision — try the next suffix
      }
      throw error;
    }
  }
  throw new SellerError("Could not generate a unique store URL. Try a different store name.");
}

export async function getSellerByOwnerId(userId: string) {
  return prisma.seller.findUnique({ where: { ownerId: userId } });
}

export interface UpdateSellerProfileInput {
  readonly storeName: string;
  readonly description?: string;
  readonly logoUrl?: string;
}

/**
 * Self-service storefront profile edit — confirmed absent: `storeName`,
 * `description`, and `logoUrl` were only ever set once, at
 * `applyToBecomeSeller` time, with no way for a seller to update their own
 * public-facing profile afterward. `slug` is deliberately NOT editable
 * here — it's the store's real URL (`/sellers/[slug]`), and changing it
 * would break every existing link/bookmark to the store, the same
 * "URLs are permanent identifiers" reasoning product/order slugs already
 * get elsewhere in this codebase. No format validation on `logoUrl` beyond
 * trimming — matches this codebase's existing, equally lightweight
 * `imageUrl` handling for products (there's no real upload pipeline; both
 * are plain pasted URLs).
 */
export async function updateSellerProfile(sellerId: string, input: UpdateSellerProfileInput) {
  const storeName = input.storeName.trim();
  if (storeName.length < 2) {
    throw new SellerError("Store name must be at least 2 characters.");
  }

  return prisma.seller.update({
    where: { id: sellerId },
    data: {
      storeName,
      description: input.description?.trim() || null,
      logoUrl: input.logoUrl?.trim() || null,
    },
  });
}

/**
 * Self-service, reversible storefront pause — deliberately independent
 * of `status` (see schema.prisma's own comment on `vacationAt`): a
 * seller going on vacation is never a trust & safety action, so this
 * never touches `SUSPENDED`/`reviewedBy`. Scoped by `sellerId` alone,
 * exactly like `updateSellerProfile` — the caller already resolved this
 * from the real, authenticated owner via `requireApprovedSeller`.
 */
export async function setSellerVacation(sellerId: string, onVacation: boolean): Promise<void> {
  await prisma.seller.update({
    where: { id: sellerId },
    data: { vacationAt: onVacation ? new Date() : null },
  });
}

export async function getSellerBySlug(slug: string) {
  return prisma.seller.findUnique({ where: { slug } });
}

export async function listSellersByStatus(status: SellerStatus) {
  return prisma.seller.findMany({ where: { status }, orderBy: { createdAt: "asc" } });
}

export async function listAllSellers() {
  return prisma.seller.findMany({ orderBy: { createdAt: "desc" } });
}

async function transition(
  sellerId: string,
  to: SellerStatus,
  reviewerUserId: string,
  rejectionReason?: string,
): Promise<void> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) throw new SellerError("Seller not found.");

  if (!canTransitionSeller(seller.status, to)) {
    throw new SellerError(`Cannot move a seller from ${seller.status} to ${to}.`);
  }

  await prisma.seller.update({
    where: { id: sellerId },
    data: {
      status: to,
      reviewedAt: new Date(),
      reviewedBy: reviewerUserId,
      rejectionReason: to === "REJECTED" ? (rejectionReason?.trim() || "No reason given.") : null,
    },
  });

  logger.info("seller.status_changed", { sellerId, from: seller.status, to, reviewerUserId });
}

export async function approveSeller(sellerId: string, reviewerUserId: string): Promise<void> {
  await transition(sellerId, "APPROVED", reviewerUserId);
}

export async function rejectSeller(sellerId: string, reviewerUserId: string, reason: string): Promise<void> {
  await transition(sellerId, "REJECTED", reviewerUserId, reason);
}

export async function suspendSeller(sellerId: string, reviewerUserId: string): Promise<void> {
  await transition(sellerId, "SUSPENDED", reviewerUserId);
}

export async function reinstateSeller(sellerId: string, reviewerUserId: string): Promise<void> {
  await transition(sellerId, "APPROVED", reviewerUserId);
}

/**
 * Admin-only commission adjustment. Can never retroactively alter a ledger
 * entry that already exists: settlement-service.ts computes each
 * SellerLedgerEntry pair (SALE/COMMISSION) once, at settlement time, and
 * that entry is then immutable — the same "an order line is a historical
 * record, not a view" principle OrderLine's own schema comment states.
 * (Settlement reads the seller's CURRENT commissionBps at the moment the
 * outbox processes "order.paid", which normally follows payment within
 * moments — not the rate in effect when the order was placed. A rate
 * change landing inside that brief window is a real, narrow edge case, not
 * one worth a snapshot-on-order field for.)
 */
export async function setSellerCommission(sellerId: string, commissionBps: number, adminUserId: string): Promise<void> {
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new SellerError("Commission must be a whole number of basis points between 0 and 10000 (0-100%).");
  }

  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) throw new SellerError("Seller not found.");

  await prisma.seller.update({ where: { id: sellerId }, data: { commissionBps } });
  logger.info("seller.commission_changed", { sellerId, from: seller.commissionBps, to: commissionBps, adminUserId });
}

/**
 * The gate every seller-only write action (create/edit a listing, view
 * sold orders) must call first — never trust a client-supplied sellerId.
 * Throws for: no store at all, PENDING (not reviewed yet), REJECTED, or
 * SUSPENDED. Only an APPROVED seller can act as a seller.
 */
export async function requireApprovedSeller(userId: string) {
  const seller = await getSellerByOwnerId(userId);
  if (!seller) {
    throw new SellerError("You don't have a seller account yet.");
  }
  if (seller.status !== "APPROVED") {
    throw new SellerError(
      seller.status === "PENDING"
        ? "Your seller application is still under review."
        : seller.status === "SUSPENDED"
          ? "Your seller account is suspended. Contact support."
          : "Your seller application was declined.",
    );
  }
  return seller;
}
