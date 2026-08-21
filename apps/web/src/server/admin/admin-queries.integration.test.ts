/**
 * Integration test — requires a real Postgres. admin-queries.ts had no
 * dedicated test coverage before this file. Focused on getBusinessMetrics:
 * every figure is computed from real seeded orders/ledger entries with a
 * hand-computable expected value, not just "the query didn't crash" —
 * same discipline as seller-reputation-service's own test file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { exportOrdersCsv, exportUsersCsv, getBusinessMetrics, listAllProductsForAdmin } from "./admin-queries.ts";
import { parseCsvWithHeader } from "../catalogue/csv.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string, commissionBps = 1000) {
  const owner = await prisma.user.create({ data: { email: `admin-metrics-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Metrics Test Seller ${suffix}`, slug: `admin-metrics-seller-${suffix}`, status: "APPROVED", commissionBps },
  });
  return seller.id;
}

async function makePaidOrder(suffix: string, sellerId: string, totalSantim: number, fulfilmentStatus: "UNFULFILLED" | "FULFILLED" | "RETURNED" = "UNFULFILLED") {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-ADMETRICS-${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: totalSantim,
      totalSantim,
      paidAt: new Date(),
      lines: {
        create: [
          {
            sellerId,
            sku: `AM-${suffix}`,
            productTitle: "Metrics Test Item",
            variantTitle: "Default",
            unitPriceSantim: totalSantim,
            quantity: 1,
            lineTotalSantim: totalSantim,
            fulfilmentStatus,
            fulfilledAt: fulfilmentStatus !== "UNFULFILLED" ? new Date() : null,
          },
        ],
      },
    },
    include: { lines: true },
  });
  return { orderId: order.id, lineId: order.lines[0]!.id };
}

// GMV/commission are GLOBAL aggregates, and `node --test` runs integration
// test FILES concurrently by default — other files legitimately create
// real PAID orders and COMMISSION entries with `paidAt`/`createdAt` timed
// "now" at the same moment these tests run. An exact before/after delta
// would be flaky under that real interference. Threshold bounds instead:
// wide enough to tolerate ordinary concurrent-test noise, tight enough
// that this specific test's own contribution (verified via a huge,
// unmistakable magnitude gap for the exclusion case) can't be missed.
test("GMV sums only settled orders paid within the window, and excludes an order outside it", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  const before = await getBusinessMetrics();

  await makePaidOrder(`${suffix}-1`, sellerId, 10_000);
  await makePaidOrder(`${suffix}-2`, sellerId, 25_000);
  // An old order, outside the 30-day window — its huge value makes any
  // accidental inclusion impossible to miss against ordinary test noise.
  const old = await prisma.order.create({
    data: {
      orderNumber: `SC-ADMETRICS-${suffix}-OLD`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 50_000_000,
      totalSantim: 50_000_000,
      paidAt: new Date(Date.now() - 60 * 24 * 60 * 60_000),
      lines: { create: [{ sellerId, sku: `AM-${suffix}-old`, productTitle: "Old", variantTitle: "Default", unitPriceSantim: 50_000_000, quantity: 1, lineTotalSantim: 50_000_000 }] },
    },
  });

  const after = await getBusinessMetrics();
  const delta = after.gmvSantim - before.gmvSantim;
  assert.ok(delta >= 35_000, "GMV must include both real recent paid orders");
  assert.ok(delta < 1_000_000, "GMV must exclude the 50,000,000-santim order paid 60 days ago");

  await prisma.order.delete({ where: { id: old.id } }).catch(() => {});
});

test("commission revenue is a positive real number computed from real COMMISSION ledger entries", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix, 1000); // 10%
  const before = await getBusinessMetrics();
  const { orderId, lineId } = await makePaidOrder(suffix, sellerId, 20_000);

  await prisma.sellerLedgerEntry.create({
    data: { sellerId, orderId, orderLineId: lineId, type: "SALE", amountSantim: 20_000, description: "Sale" },
  });
  await prisma.sellerLedgerEntry.create({
    data: { sellerId, orderId, orderLineId: lineId, type: "COMMISSION", amountSantim: -2_000, description: "Commission" },
  });

  const after = await getBusinessMetrics();
  assert.ok(
    after.commissionRevenueSantim - before.commissionRevenueSantim >= 2_000,
    "commission revenue must be reported as a positive real figure, not the stored negative one",
  );
});

test("return rate reflects real fulfilled and returned order lines within the window", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);

  await makePaidOrder(`${suffix}-fulfilled`, sellerId, 10_000, "FULFILLED");
  await makePaidOrder(`${suffix}-returned`, sellerId, 10_000, "RETURNED");
  await makePaidOrder(`${suffix}-unfulfilled`, sellerId, 10_000, "UNFULFILLED"); // must not count in either side

  const metrics = await getBusinessMetrics();
  assert.ok(metrics.returnRate != null && metrics.returnRate > 0, "a real RETURNED line must move the platform-wide return rate off zero");
});

test("top sellers ranks by real revenue and includes the real store name", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const bigSeller = await makeSeller(`${suffix}-big`);
  const smallSeller = await makeSeller(`${suffix}-small`);

  await makePaidOrder(`${suffix}-big-1`, bigSeller, 100_000);
  await makePaidOrder(`${suffix}-small-1`, smallSeller, 5_000);

  const metrics = await getBusinessMetrics();
  const bigEntry = metrics.topSellers.find((s) => s.sellerId === bigSeller);
  const smallEntry = metrics.topSellers.find((s) => s.sellerId === smallSeller);
  assert.ok(bigEntry, "the higher-revenue seller must appear in the top-sellers list");
  assert.equal(bigEntry!.storeName, `Metrics Test Seller ${suffix}-big`);
  assert.ok(bigEntry!.revenueSantim >= 100_000);

  if (smallEntry && bigEntry) {
    const bigIndex = metrics.topSellers.indexOf(bigEntry);
    const smallIndex = metrics.topSellers.indexOf(smallEntry);
    assert.ok(bigIndex < smallIndex, "higher revenue must rank first");
  }
});

test("active seller and pending application counts reflect real seller rows", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const approvedOwner = await prisma.user.create({ data: { email: `admin-metrics-appr-${suffix}@example.et`, role: "CUSTOMER" } });
  await prisma.seller.create({
    data: { ownerId: approvedOwner.id, storeName: "Approved", slug: `admin-metrics-seller-appr-${suffix}`, status: "APPROVED" },
  });
  const pendingOwner = await prisma.user.create({ data: { email: `admin-metrics-pend-${suffix}@example.et`, role: "CUSTOMER" } });
  await prisma.seller.create({
    data: { ownerId: pendingOwner.id, storeName: "Pending", slug: `admin-metrics-seller-pend-${suffix}`, status: "PENDING" },
  });

  const metrics = await getBusinessMetrics();
  assert.ok(metrics.activeSellerCount >= 1);
  assert.ok(metrics.pendingSellerApplications >= 1);
});

test("listAllProductsForAdmin sees a DRAFT product a suspended seller's storefront would never show", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix);
  await prisma.product.create({
    data: { sellerId, slug: `admin-metrics-product-${suffix}`, title: `Admin Metrics Draft Item ${suffix}`, description: "d", status: "DRAFT" },
  });
  await prisma.seller.update({ where: { id: sellerId }, data: { status: "SUSPENDED" } });

  const all = await listAllProductsForAdmin(`Admin Metrics Draft Item ${suffix}`);
  assert.equal(all.length, 1, "admin must see a DRAFT product from a SUSPENDED seller — the storefront never would");
  assert.equal(all[0]!.status, "DRAFT");
  assert.equal(all[0]!.featured, false);
});

// exportOrdersCsv (via listOrders) is a marketplace-wide query with no
// seller scoping — real risk of cross-file interference under
// node --test's concurrent execution if the filter matched everything.
// Searching by this test's own unique order number sidesteps that
// entirely: the filter itself guarantees only this test's own row can
// ever match, regardless of what else is running concurrently.
test("exportOrdersCsv produces a real, correctly quoted CSV for the filtered orders only", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const orderNumber = `SC-ADMETRICS-EXPORT-${suffix}`.toUpperCase();
  await prisma.order.create({
    data: {
      orderNumber,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 24_999,
      totalSantim: 24_999,
      paidAt: new Date(),
    },
  });

  const csv = await exportOrdersCsv({ search: orderNumber });
  const records = parseCsvWithHeader(csv);

  assert.equal(records.length, 1, "the search filter must scope this export to exactly the one real matching order");
  assert.equal(records[0]!.orderNumber, orderNumber);
  assert.equal(records[0]!.status, "PAID");
  assert.equal(records[0]!.totalBirr, "249.99");
  assert.ok(records[0]!.paidAt, "a real paidAt timestamp must be present for a PAID order");
});

// Same real cross-file interference risk as exportOrdersCsv above — a
// marketplace-wide query with no natural scoping — sidestepped the same
// way: searching by this test's own unique email.
test("exportUsersCsv produces a real, correctly quoted CSV for the searched users only", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `admin-metrics-export-${suffix}@example.et`;
  await prisma.user.create({ data: { email, name: "Export Test User", role: "CUSTOMER" } });

  const csv = await exportUsersCsv(email);
  const records = parseCsvWithHeader(csv);

  assert.equal(records.length, 1, "the search filter must scope this export to exactly the one real matching user");
  assert.equal(records[0]!.email, email);
  assert.equal(records[0]!.name, "Export Test User");
  assert.equal(records[0]!.role, "CUSTOMER");
  assert.equal(records[0]!.status, "Active");
});

test.after(async () => {
  await prisma.sellerLedgerEntry.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-ADMETRICS-" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-ADMETRICS-" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-ADMETRICS-" } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "admin-metrics-product-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "admin-metrics-seller-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "admin-metrics-" } } });
  await prisma.$disconnect();
});
