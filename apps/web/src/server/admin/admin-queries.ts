/**
 * Admin read queries.
 *
 * Split from `catalogue-service.ts`/customer-facing queries for the same
 * reason those are split from a write path: different access pattern
 * (low-volume, staff-only), different shape (exposes email, addresses,
 * gateway transaction ids — never sent to the storefront), different
 * evolution speed.
 */

import type { OrderStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "../db.js";

export interface OrderFilter {
  status?: OrderStatus;
  search?: string;
}

export async function listOrders(filter: OrderFilter, take = 50) {
  return prisma.order.findMany({
    where: {
      status: filter.status,
      ...(filter.search
        ? {
            OR: [
              { orderNumber: { contains: filter.search, mode: "insensitive" } },
              { email: { contains: filter.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { placedAt: "desc" },
    take,
    select: {
      id: true,
      orderNumber: true,
      email: true,
      status: true,
      fulfilmentStatus: true,
      totalSantim: true,
      placedAt: true,
      paidAt: true,
    },
  });
}

export async function getOrderDetail(orderNumber: string) {
  return prisma.order.findUnique({
    where: { orderNumber },
    include: {
      lines: true,
      payments: {
        orderBy: { createdAt: "desc" },
        include: { events: { orderBy: { receivedAt: "desc" }, take: 10 } },
      },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
}

/** Payments the poller hasn't resolved and that are old enough to need a human look. */
export async function listStuckPayments(olderThanMinutes = 20) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return prisma.paymentIntent.findMany({
    where: {
      status: { in: ["CREATED", "PENDING", "EXPIRED"] },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    include: { order: { select: { orderNumber: true, email: true, status: true } } },
    take: 100,
  });
}

export interface DashboardStats {
  ordersToday: number;
  paidToday: number;
  revenueTodaySantim: number;
  stuckPayments: number;
  pendingReservationsExpiringSoon: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [ordersToday, paidOrders, stuckPayments, expiringReservations] = await Promise.all([
    prisma.order.count({ where: { placedAt: { gte: startOfDay } } }),
    prisma.order.findMany({
      where: { status: "PAID", paidAt: { gte: startOfDay } },
      select: { totalSantim: true },
    }),
    prisma.paymentIntent.count({
      where: {
        status: { in: ["CREATED", "PENDING", "EXPIRED"] },
        createdAt: { lt: new Date(Date.now() - 20 * 60_000) },
      },
    }),
    prisma.inventoryReservation.count({
      where: { status: "HELD", expiresAt: { lt: new Date(Date.now() + 5 * 60_000) } },
    }),
  ]);

  return {
    ordersToday,
    paidToday: paidOrders.length,
    revenueTodaySantim: paidOrders.reduce((sum, o) => sum + o.totalSantim, 0),
    stuckPayments,
    pendingReservationsExpiringSoon: expiringReservations,
  };
}

const SETTLED_ORDER_STATUSES = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"] as const;
const BUSINESS_METRICS_WINDOW_DAYS = 30;

export interface TopSeller {
  readonly sellerId: string;
  readonly storeName: string;
  readonly revenueSantim: number;
}

export interface BusinessMetrics {
  readonly windowDays: number;
  /** Gross Merchandise Value — total order value across settled orders in the window. */
  readonly gmvSantim: number;
  /** The marketplace's own cut — always >= 0, even though the underlying ledger entries are stored negative. */
  readonly commissionRevenueSantim: number;
  readonly activeSellerCount: number;
  readonly pendingSellerApplications: number;
  /** Fraction of fulfilled-or-returned order lines created in the window that were RETURNED. Null with no data. */
  readonly returnRate: number | null;
  readonly topSellers: readonly TopSeller[];
}

/**
 * Real marketplace business metrics — GMV, commission revenue, seller
 * counts, return rate, top sellers — distinct from getDashboardStats()'s
 * ops-health tiles (stuck payments, expiring reservations) above. Both
 * live on the same admin dashboard page but answer different questions:
 * "is anything broken right now" vs "how is the marketplace actually
 * performing".
 */
export async function getBusinessMetrics(): Promise<BusinessMetrics> {
  const windowStart = new Date(Date.now() - BUSINESS_METRICS_WINDOW_DAYS * 24 * 60 * 60_000);

  const [gmv, commission, activeSellerCount, pendingSellerApplications, fulfilledOrReturned, returned, topSellerRows] =
    await Promise.all([
      prisma.order.aggregate({
        where: { status: { in: [...SETTLED_ORDER_STATUSES] }, paidAt: { gte: windowStart } },
        _sum: { totalSantim: true },
      }),
      prisma.sellerLedgerEntry.aggregate({
        where: { type: "COMMISSION", createdAt: { gte: windowStart } },
        _sum: { amountSantim: true },
      }),
      prisma.seller.count({ where: { status: "APPROVED" } }),
      prisma.seller.count({ where: { status: "PENDING" } }),
      prisma.orderLine.count({
        where: {
          createdAt: { gte: windowStart },
          fulfilmentStatus: { in: ["FULFILLED", "RETURNED"] },
        },
      }),
      prisma.orderLine.count({
        where: { createdAt: { gte: windowStart }, fulfilmentStatus: "RETURNED" },
      }),
      prisma.orderLine.groupBy({
        by: ["sellerId"],
        where: {
          order: { status: { in: [...SETTLED_ORDER_STATUSES] }, paidAt: { gte: windowStart } },
        },
        _sum: { lineTotalSantim: true },
        orderBy: { _sum: { lineTotalSantim: "desc" } },
        take: 5,
      }),
    ]);

  const sellers = await prisma.seller.findMany({
    where: { id: { in: topSellerRows.map((r) => r.sellerId) } },
    select: { id: true, storeName: true },
  });
  const storeNameById = new Map(sellers.map((s) => [s.id, s.storeName]));

  return {
    windowDays: BUSINESS_METRICS_WINDOW_DAYS,
    gmvSantim: gmv._sum.totalSantim ?? 0,
    commissionRevenueSantim: -(commission._sum.amountSantim ?? 0),
    activeSellerCount,
    pendingSellerApplications,
    returnRate: fulfilledOrReturned > 0 ? returned / fulfilledOrReturned : null,
    topSellers: topSellerRows.map((r) => ({
      sellerId: r.sellerId,
      storeName: storeNameById.get(r.sellerId) ?? "Unknown seller",
      revenueSantim: r._sum.lineTotalSantim ?? 0,
    })),
  };
}

export type { OrderStatus, PaymentStatus };
