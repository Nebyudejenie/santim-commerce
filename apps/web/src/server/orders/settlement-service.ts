/**
 * Seller settlement: turns a paid order into real, auditable ledger
 * entries. Called from the worker's outbox consumer (worker/index.ts's
 * `deliver()`, topic "order.paid") — NOT from inside
 * payment-service.ts's payment transaction. That's deliberate, not an
 * oversight: this codebase's own established rule (see
 * applyPaymentTransition's module comment) is that side effects go
 * through the outbox, never a direct call inside the transaction that
 * confirms payment — the exact same reasoning that already applies to
 * emails and search reindexing applies here too.
 */

import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";
import { computeLedgerAmounts } from "./ledger-calculation.js";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export class SettlementError extends Error {
  override name = "SettlementError";
}

/**
 * Idempotent under the outbox's real at-least-once delivery semantics —
 * see schema.prisma's own comment on SellerLedgerEntry's
 * `@@unique([orderLineId, type])`. A redelivered "order.paid" message for
 * an order whose ledger entries already exist hits that constraint on
 * every line and is treated as a no-op success, not an error — the
 * outbox's retry-with-backoff must never turn "this already happened"
 * into a permanent delivery failure.
 */
export async function createLedgerEntriesForOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { include: { seller: { select: { id: true, commissionBps: true } } } } },
  });
  if (!order) {
    logger.error("settlement.order_not_found", { orderId });
    return;
  }

  for (const line of order.lines) {
    const amounts = computeLedgerAmounts(line.lineTotalSantim, line.seller.commissionBps);

    try {
      await prisma.$transaction([
        prisma.sellerLedgerEntry.create({
          data: {
            sellerId: line.sellerId,
            orderId: order.id,
            orderLineId: line.id,
            type: "SALE",
            amountSantim: amounts.saleSantim,
            description: `Sale: ${line.productTitle} × ${line.quantity} (order ${order.orderNumber})`,
          },
        }),
        prisma.sellerLedgerEntry.create({
          data: {
            sellerId: line.sellerId,
            orderId: order.id,
            orderLineId: line.id,
            type: "COMMISSION",
            amountSantim: amounts.commissionSantim,
            description: `Marketplace commission (${(line.seller.commissionBps / 100).toFixed(2)}%)`,
          },
        }),
      ]);
      logger.info("settlement.ledger_entries_created", {
        orderId: order.id,
        orderLineId: line.id,
        sellerId: line.sellerId,
        netPayableSantim: amounts.netPayableSantim,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Already settled this line — a redelivered outbox message, not a bug.
        logger.info("settlement.already_settled", { orderId: order.id, orderLineId: line.id });
        continue;
      }
      throw error;
    }
  }

  await createCouponDiscountEntry(order.id, order.orderNumber, order.lines);
}

/**
 * A seller-issued coupon's discount comes out of THAT seller's own payout —
 * never the marketplace's, and never a different seller's who happened to
 * share the order — see coupon-service.ts's own comment. Attributed to the
 * funding seller's FIRST line in the order (a deterministic pick, since
 * SellerLedgerEntry requires a real orderLineId and a coupon discount is
 * conceptually an order-level, not line-level, fact) — correctness only
 * requires the SUM across that seller's entries be right, and the
 * CouponRedemption row independently records the true originating fact
 * (which coupon, whose seller, how much) for audit regardless of which
 * line the entry is attached to.
 *
 * An admin/platform-wide coupon (Coupon.sellerId null) creates no entry
 * here at all — the marketplace absorbs that discount, unchanged from
 * before this feature existed.
 */
async function createCouponDiscountEntry(
  orderId: string,
  orderNumber: string,
  lines: readonly { id: string; sellerId: string; createdAt: Date }[],
): Promise<void> {
  const redemption = await prisma.couponRedemption.findUnique({
    where: { orderId },
    include: { coupon: { select: { sellerId: true, code: true } } },
  });
  if (!redemption || !redemption.coupon.sellerId || redemption.discountSantim <= 0) return;

  const fundingSellerId = redemption.coupon.sellerId;
  const sellerLines = lines.filter((l) => l.sellerId === fundingSellerId);
  if (sellerLines.length === 0) {
    // Should be unreachable — coupon-service.ts's relevantSubtotal already
    // requires the funding seller to have real lines in the cart before a
    // redemption is even allowed. Logged, not thrown: settlement must never
    // fail an otherwise-successful order over an inconsistency this deep.
    logger.error("settlement.coupon_discount_seller_not_in_order", { orderId, fundingSellerId });
    return;
  }
  const [firstLine] = sellerLines.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  try {
    await prisma.sellerLedgerEntry.create({
      data: {
        sellerId: fundingSellerId,
        orderId,
        orderLineId: firstLine!.id,
        type: "COUPON_DISCOUNT",
        amountSantim: -redemption.discountSantim,
        description: `Coupon ${redemption.coupon.code} discount (order ${orderNumber})`,
      },
    });
    logger.info("settlement.coupon_discount_entry_created", {
      orderId,
      sellerId: fundingSellerId,
      amountSantim: -redemption.discountSantim,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      logger.info("settlement.coupon_discount_already_settled", { orderId, sellerId: fundingSellerId });
      return;
    }
    throw error;
  }
}

export interface SellerBalance {
  readonly payableSantim: number;
  readonly settledSantim: number;
  readonly lifetimeNetSantim: number;
}

/** The seller's current balance, computed from real ledger history — never
 * a stored running total (see the model's own comment on why). */
export async function getSellerBalance(sellerId: string): Promise<SellerBalance> {
  const [payable, settled, lifetime] = await Promise.all([
    prisma.sellerLedgerEntry.aggregate({
      where: { sellerId, settledAt: null },
      _sum: { amountSantim: true },
    }),
    prisma.sellerLedgerEntry.aggregate({
      where: { sellerId, settledAt: { not: null } },
      _sum: { amountSantim: true },
    }),
    prisma.sellerLedgerEntry.aggregate({
      where: { sellerId },
      _sum: { amountSantim: true },
    }),
  ]);

  return {
    payableSantim: payable._sum.amountSantim ?? 0,
    settledSantim: settled._sum.amountSantim ?? 0,
    lifetimeNetSantim: lifetime._sum.amountSantim ?? 0,
  };
}

export async function listSellerLedgerEntries(sellerId: string, take = 100) {
  return prisma.sellerLedgerEntry.findMany({
    where: { sellerId },
    orderBy: { createdAt: "desc" },
    take,
    include: { order: { select: { orderNumber: true } } },
  });
}

export interface SellerWithPayableBalance {
  readonly sellerId: string;
  readonly storeName: string;
  readonly slug: string;
  readonly payableSantim: number;
}

/** Every seller with a real, positive, still-unsettled balance — the
 * admin payouts queue. A seller whose ledger nets to zero or negative
 * (e.g. return refunds outweighing sales right now) has nothing to pay
 * out and is correctly excluded, not shown as "owed 0". */
export async function listSellersWithPayableBalance(): Promise<SellerWithPayableBalance[]> {
  const grouped = await prisma.sellerLedgerEntry.groupBy({
    by: ["sellerId"],
    where: { settledAt: null },
    _sum: { amountSantim: true },
  });
  const owed = grouped.filter((g) => (g._sum.amountSantim ?? 0) > 0);
  if (owed.length === 0) return [];

  const sellers = await prisma.seller.findMany({
    where: { id: { in: owed.map((o) => o.sellerId) } },
    select: { id: true, storeName: true, slug: true },
  });
  const sellerById = new Map(sellers.map((s) => [s.id, s]));

  return owed
    .map((o) => {
      const seller = sellerById.get(o.sellerId);
      return {
        sellerId: o.sellerId,
        storeName: seller?.storeName ?? "Unknown seller",
        slug: seller?.slug ?? "",
        payableSantim: o._sum.amountSantim ?? 0,
      };
    })
    .sort((a, b) => b.payableSantim - a.payableSantim);
}

export interface RecordedPayout {
  readonly settledSantim: number;
  readonly entriesCount: number;
}

/**
 * Records a payout the admin has ALREADY sent outside this system (bank
 * transfer, mobile money — whatever the marketplace's real, current
 * process is) — this function does NOT move any real money itself. See
 * SellerLedgerEntry.settledAt's own comment: a real, automated payout
 * mechanism (SantimPay's B2C payout endpoint) carries the same
 * unconfirmed-gateway-semantics risk already flagged for refunds and is
 * deliberately not built. Recording what an admin attests they already
 * did in the real world is a different, honest thing from the system
 * claiming to have paid someone itself — the Server Action and UI copy
 * for this must stay explicit about that distinction.
 *
 * Settles the seller's ENTIRE current payable balance atomically, not a
 * partial amount — matching how an early-stage marketplace's real payout
 * process actually works (one transfer covering the current balance), and
 * avoiding the real complexity a partial-settlement UI would need (which
 * specific entries, tracked how) for a v1 that doesn't need it yet.
 */
export async function recordSellerPayout(sellerId: string): Promise<RecordedPayout> {
  return prisma.$transaction(async (tx) => {
    const unsettled = await tx.sellerLedgerEntry.findMany({
      where: { sellerId, settledAt: null },
      select: { id: true, amountSantim: true },
    });
    if (unsettled.length === 0) {
      throw new SettlementError("Nothing owed to this seller right now.");
    }

    const totalSantim = unsettled.reduce((sum, e) => sum + e.amountSantim, 0);
    if (totalSantim <= 0) {
      throw new SettlementError("This seller has no positive payable balance to record a payout for.");
    }

    await tx.sellerLedgerEntry.updateMany({
      where: { id: { in: unsettled.map((e) => e.id) } },
      data: { settledAt: new Date() },
    });

    logger.info("settlement.payout_recorded", { sellerId, settledSantim: totalSantim, entriesCount: unsettled.length });
    return { settledSantim: totalSantim, entriesCount: unsettled.length };
  });
}

const SELLER_METRICS_WINDOW_DAYS = 30;

export interface SellerTopProduct {
  readonly productTitle: string;
  readonly unitsSold: number;
  readonly revenueSantim: number;
}

export interface SellerBusinessMetrics {
  readonly windowDays: number;
  readonly ordersCount: number;
  readonly grossSalesSantim: number;
  readonly topProducts: readonly SellerTopProduct[];
}

/**
 * A single seller's own version of admin-queries.ts's getBusinessMetrics —
 * same "how is business actually going" question, scoped down to one
 * store instead of the whole marketplace. Deliberately groups top
 * products by the SNAPSHOTTED `productTitle` on OrderLine, not a live
 * Product join: this schema's own stated philosophy (OrderLine's module
 * comment) is "a historical record, not a view" — a renamed or deleted
 * product must never silently break or misattribute past sales figures.
 */
export async function getSellerBusinessMetrics(sellerId: string): Promise<SellerBusinessMetrics> {
  const windowStart = new Date(Date.now() - SELLER_METRICS_WINDOW_DAYS * 24 * 60 * 60_000);

  const lines = await prisma.orderLine.findMany({
    where: {
      sellerId,
      // paidAt, not the line's own createdAt (order-placement time) — same
      // "when did the sale actually happen" semantic admin-queries.ts's
      // getBusinessMetrics uses for its GMV window, for the same reason: a
      // delayed or resumed payment can leave createdAt meaningfully earlier
      // than when the sale was actually real.
      order: { status: { in: ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] }, paidAt: { gte: windowStart } },
    },
    select: { orderId: true, productTitle: true, quantity: true, lineTotalSantim: true },
  });

  const distinctOrderIds = new Set(lines.map((l) => l.orderId));
  const grossSalesSantim = lines.reduce((sum, l) => sum + l.lineTotalSantim, 0);

  const byProduct = new Map<string, { unitsSold: number; revenueSantim: number }>();
  for (const line of lines) {
    const existing = byProduct.get(line.productTitle) ?? { unitsSold: 0, revenueSantim: 0 };
    existing.unitsSold += line.quantity;
    existing.revenueSantim += line.lineTotalSantim;
    byProduct.set(line.productTitle, existing);
  }
  const topProducts = [...byProduct.entries()]
    .map(([productTitle, v]) => ({ productTitle, ...v }))
    .sort((a, b) => b.revenueSantim - a.revenueSantim)
    .slice(0, 5);

  return {
    windowDays: SELLER_METRICS_WINDOW_DAYS,
    ordersCount: distinctOrderIds.size,
    grossSalesSantim,
    topProducts,
  };
}
