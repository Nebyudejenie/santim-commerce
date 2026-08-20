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
