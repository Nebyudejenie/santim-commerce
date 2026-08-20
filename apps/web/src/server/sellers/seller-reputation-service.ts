/**
 * Seller reputation — real metrics computed from actual order, return, and
 * review history, not a placeholder score. Explicit foundation for future
 * ranking/tiers (the master mandate's own framing), not a ranking system
 * itself: this only computes and exposes the numbers.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * -----------------------------------
 * This codebase's OrderStatus enum has no PROCESSING/PACKED/SHIPPED/
 * IN_TRANSIT/DELIVERED granularity — only PENDING_PAYMENT/PAID/FAILED/
 * CANCELLED/REFUNDED/PARTIALLY_REFUNDED at the Order level, plus per-line
 * UNFULFILLED/PARTIALLY_FULFILLED/FULFILLED/RETURNED. "Late shipment" here
 * is measured against a DOCUMENTED DEFAULT SLA (fulfilledAt - paidAt <= 48h
 * counts as on-time), not a real seller-negotiated SLA — no such concept
 * exists in the schema. Treat lateShipmentRate as a reasonable proxy, not a
 * contractual figure, until a real SLA field exists.
 *
 * "Response time" means review-response time (createdAt -> sellerRespondedAt
 * on ProductReview) — the only real "seller responded to something" event
 * this codebase has. There is no buyer-seller messaging system yet, so this
 * is NOT a claim about message response time.
 *
 * "Dispute rate" is the fraction of resolved return requests that needed
 * ADMIN escalation rather than the seller's own resolution — computed by
 * comparing ReturnRequest.resolvedByUserId against this seller's own id
 * (see return-service.ts: a seller-resolved return stores the SELLER's id
 * there, an admin-resolved one stores the ADMIN USER's id — different ID
 * namespaces that happen to never collide, so this comparison is reliable
 * without needing a join).
 *
 * PERFORMANCE: rate metrics (completion/cancellation/return) are plain
 * indexed COUNT queries — cheap regardless of a seller's history size.
 * Time-based averages (late-shipment, review-response) need per-row
 * timestamp differences, so those are computed over a bounded, most-recent
 * sample rather than a seller's entire history — a real, documented scale
 * trade-off, not an oversight.
 */

import { prisma } from "../db.js";
import { getSellerRating } from "../reviews/review-service.js";

const LATE_SHIPMENT_SLA_HOURS = 48;
const RECENT_SAMPLE_SIZE = 500;
const RECENT_REVIEW_SAMPLE_SIZE = 200;

const SETTLED_ORDER_STATUSES = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] as const;
const FULFILLED_OR_RETURNED = ["FULFILLED", "RETURNED"] as const;

export interface SellerReputationMetrics {
  readonly totalOrderLines: number;
  readonly settledOrderLines: number;
  /** Fraction of settled lines that reached FULFILLED or RETURNED (i.e. were actually shipped), or null with no settled lines. */
  readonly completionRate: number | null;
  /** Fraction of ALL this seller's lines whose order was CANCELLED, or null with no lines at all. */
  readonly cancellationRate: number | null;
  /** Fraction of fulfilled-or-returned lines that were RETURNED, or null with none fulfilled. */
  readonly returnRate: number | null;
  /** Over the most recent RECENT_SAMPLE_SIZE fulfilled lines with a known paidAt — fraction shipped later than the default SLA. Null if no eligible sample. */
  readonly lateShipmentRate: number | null;
  readonly averageRating: number | null;
  readonly reviewCount: number;
  /** Average hours between a review being posted and the seller responding, over the most recent sample. Null if no responded reviews. */
  readonly avgReviewResponseHours: number | null;
  /** Fraction of resolved return requests that needed admin escalation. Null if none resolved. */
  readonly disputeRate: number | null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export async function getSellerReputation(sellerId: string): Promise<SellerReputationMetrics> {
  const [
    totalOrderLines,
    settledOrderLines,
    fulfilledOrReturnedLines,
    returnedLines,
    cancelledLines,
    rating,
    lateShipmentStats,
    reviewResponseStats,
    disputeStats,
  ] = await Promise.all([
    prisma.orderLine.count({ where: { sellerId } }),
    prisma.orderLine.count({ where: { sellerId, order: { status: { in: [...SETTLED_ORDER_STATUSES] } } } }),
    prisma.orderLine.count({
      where: {
        sellerId,
        order: { status: { in: [...SETTLED_ORDER_STATUSES] } },
        fulfilmentStatus: { in: [...FULFILLED_OR_RETURNED] },
      },
    }),
    prisma.orderLine.count({
      where: { sellerId, order: { status: { in: [...SETTLED_ORDER_STATUSES] } }, fulfilmentStatus: "RETURNED" },
    }),
    prisma.orderLine.count({ where: { sellerId, order: { status: "CANCELLED" } } }),
    getSellerRating(sellerId),
    computeLateShipmentRate(sellerId),
    computeAvgReviewResponseHours(sellerId),
    computeDisputeRate(sellerId),
  ]);

  return {
    totalOrderLines,
    settledOrderLines,
    completionRate: rate(fulfilledOrReturnedLines, settledOrderLines),
    cancellationRate: rate(cancelledLines, totalOrderLines),
    returnRate: rate(returnedLines, fulfilledOrReturnedLines),
    lateShipmentRate: lateShipmentStats,
    averageRating: rating.average,
    reviewCount: rating.count,
    avgReviewResponseHours: reviewResponseStats,
    disputeRate: disputeStats,
  };
}

async function computeLateShipmentRate(sellerId: string): Promise<number | null> {
  const lines = await prisma.orderLine.findMany({
    where: { sellerId, fulfilmentStatus: { in: [...FULFILLED_OR_RETURNED] }, fulfilledAt: { not: null } },
    select: { fulfilledAt: true, order: { select: { paidAt: true } } },
    orderBy: { createdAt: "desc" },
    take: RECENT_SAMPLE_SIZE,
  });

  const eligible = lines.filter((l) => l.fulfilledAt != null && l.order.paidAt != null);
  if (eligible.length === 0) return null;

  const lateCount = eligible.filter((l) => {
    const hours = (l.fulfilledAt!.getTime() - l.order.paidAt!.getTime()) / (1000 * 60 * 60);
    return hours > LATE_SHIPMENT_SLA_HOURS;
  }).length;

  return lateCount / eligible.length;
}

async function computeAvgReviewResponseHours(sellerId: string): Promise<number | null> {
  const reviews = await prisma.productReview.findMany({
    where: { product: { sellerId }, sellerRespondedAt: { not: null } },
    select: { createdAt: true, sellerRespondedAt: true },
    orderBy: { createdAt: "desc" },
    take: RECENT_REVIEW_SAMPLE_SIZE,
  });

  if (reviews.length === 0) return null;

  const totalHours = reviews.reduce((sum, r) => {
    return sum + (r.sellerRespondedAt!.getTime() - r.createdAt.getTime()) / (1000 * 60 * 60);
  }, 0);

  return totalHours / reviews.length;
}

export interface BulkSellerRating {
  readonly sellerId: string;
  readonly averageRating: number;
  readonly reviewCount: number;
}

/**
 * One query for every seller's rating, for a list page (e.g. admin's
 * seller directory) — the exact "avoid N+1" case a per-row
 * `getSellerRating` loop would violate. Only sellers with at least one
 * PUBLISHED review appear in the result; callers should treat a missing
 * sellerId as "no rating yet", the same as `getSellerReputation`'s
 * `averageRating: null`.
 */
export async function getBulkSellerRatings(): Promise<BulkSellerRating[]> {
  const rows = await prisma.$queryRaw<Array<{ sellerId: string; avg_rating: number; review_count: bigint }>>`
    SELECT p."sellerId" AS "sellerId", AVG(pr."rating")::float AS avg_rating, COUNT(*) AS review_count
    FROM "product_reviews" pr
    JOIN "products" p ON p."id" = pr."productId"
    WHERE pr."status" = 'PUBLISHED'
    GROUP BY p."sellerId"
  `;
  return rows.map((r) => ({ sellerId: r.sellerId, averageRating: r.avg_rating, reviewCount: Number(r.review_count) }));
}

async function computeDisputeRate(sellerId: string): Promise<number | null> {
  const resolved = await prisma.returnRequest.findMany({
    where: { orderLine: { sellerId }, status: { in: ["APPROVED", "REJECTED"] } },
    select: { resolvedByUserId: true },
  });

  if (resolved.length === 0) return null;

  const escalated = resolved.filter((r) => r.resolvedByUserId != null && r.resolvedByUserId !== sellerId).length;
  return escalated / resolved.length;
}
