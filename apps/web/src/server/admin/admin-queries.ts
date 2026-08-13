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

export type { OrderStatus, PaymentStatus };
