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
