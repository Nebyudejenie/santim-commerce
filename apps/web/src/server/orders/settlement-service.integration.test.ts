/**
 * Integration test — requires a real Postgres. Two properties matter most
 * here, both verified against real database constraints, not mocked:
 *
 *  1. IDEMPOTENCY under the outbox's real at-least-once delivery — calling
 *     createLedgerEntriesForOrder TWICE for the same order (simulating a
 *     redelivered "order.paid" message) must not double-credit or
 *     double-charge a seller. This relies on SellerLedgerEntry's real
 *     `@@unique([orderLineId, type])` constraint, not application-level
 *     "check if it already exists first" logic (which would itself have a
 *     race condition — see this codebase's own established preference for
 *     database constraints over check-then-write, e.g. reservation.ts and
 *     ShippingLabel).
 *  2. A MULTI-SELLER order settles each seller's own commission correctly
 *     and independently — seller A's rate must never leak into seller B's
 *     ledger entries.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  createLedgerEntriesForOrder,
  getSellerBalance,
  getSellerBusinessMetrics,
  listSellerLedgerEntries,
  listSellersWithPayableBalance,
  recordSellerPayout,
  SettlementError,
} from "./settlement-service.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string, commissionBps: number) {
  const owner = await prisma.user.create({ data: { email: `ledger-test-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Ledger Test ${suffix}`, slug: `ledger-test-${suffix}`, status: "APPROVED", commissionBps },
  });
  return seller.id;
}

test("settling a single-seller order creates a real SALE and COMMISSION entry with correct net", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(suffix, 1000); // 10%

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGER${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `L-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
        ],
      },
    },
  });

  await createLedgerEntriesForOrder(order.id);

  const entries = await listSellerLedgerEntries(sellerId);
  assert.equal(entries.length, 2);
  const sale = entries.find((e) => e.type === "SALE")!;
  const commission = entries.find((e) => e.type === "COMMISSION")!;
  assert.equal(sale.amountSantim, 10_000);
  assert.equal(commission.amountSantim, -1_000);

  const balance = await getSellerBalance(sellerId);
  assert.equal(balance.payableSantim, 9_000, "net payable must be sale minus commission, still unsettled");
  assert.equal(balance.settledSantim, 0);
});

test("calling createLedgerEntriesForOrder TWICE (simulating a redelivered outbox message) does not double-settle", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`redeliver-${suffix}`, 1000);

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERREDELIV${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 5_000,
      totalSantim: 5_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `LR-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 5_000, quantity: 1, lineTotalSantim: 5_000 },
        ],
      },
    },
  });

  await createLedgerEntriesForOrder(order.id);
  await createLedgerEntriesForOrder(order.id); // the redelivery
  await createLedgerEntriesForOrder(order.id); // and once more, for good measure

  const entries = await listSellerLedgerEntries(sellerId);
  assert.equal(entries.length, 2, "still exactly one SALE and one COMMISSION entry, no duplicates from the redeliveries");

  const balance = await getSellerBalance(sellerId);
  assert.equal(balance.payableSantim, 4_500, "balance must not have been credited three times");
});

test("a multi-seller order settles each seller's own commission rate independently, never leaking between them", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerLowRate = await makeSeller(`multi-low-${suffix}`, 500); // 5%
  const sellerHighRate = await makeSeller(`multi-high-${suffix}`, 2000); // 20%

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERMULTI${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 20_000,
      totalSantim: 20_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId: sellerLowRate, sku: `LOW-${suffix}`, productTitle: "Low rate item", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
          { sellerId: sellerHighRate, sku: `HIGH-${suffix}`, productTitle: "High rate item", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
        ],
      },
    },
  });

  await createLedgerEntriesForOrder(order.id);

  const lowBalance = await getSellerBalance(sellerLowRate);
  const highBalance = await getSellerBalance(sellerHighRate);
  assert.equal(lowBalance.payableSantim, 9_500, "5% commission on 10000 = 500 deducted");
  assert.equal(highBalance.payableSantim, 8_000, "20% commission on 10000 = 2000 deducted — must not have used the other seller's 5% rate");
});

test("a seller-issued coupon's discount comes out of THAT seller's own payout, never an unrelated seller sharing the order", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const fundingSeller = await makeSeller(`coupon-funder-${suffix}`, 1000); // 10%
  const otherSeller = await makeSeller(`coupon-other-${suffix}`, 1000);
  const buyer = await prisma.user.create({ data: { email: `ledger-test-coupon-buyer-${suffix}@example.et`, role: "CUSTOMER" } });

  const coupon = await prisma.coupon.create({
    data: { code: `LEDGERCPN-${suffix}`, discountType: "FIXED_AMOUNT", discountValue: 2_000, sellerId: fundingSeller },
  });

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERCOUPON${suffix}`.toUpperCase(),
      userId: buyer.id,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 20_000,
      discountSantim: 2_000,
      totalSantim: 18_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId: fundingSeller, sku: `CPN-${suffix}`, productTitle: "Discounted item", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
          { sellerId: otherSeller, sku: `OTH-${suffix}`, productTitle: "Unrelated item", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 1, lineTotalSantim: 10_000 },
        ],
      },
    },
  });
  await prisma.couponRedemption.create({
    data: { couponId: coupon.id, userId: buyer.id, orderId: order.id, discountSantim: 2_000 },
  });

  await createLedgerEntriesForOrder(order.id);

  const funderEntries = await listSellerLedgerEntries(fundingSeller);
  assert.equal(funderEntries.length, 3, "SALE, COMMISSION, and the new COUPON_DISCOUNT entry");
  const discountEntry = funderEntries.find((e) => e.type === "COUPON_DISCOUNT")!;
  assert.ok(discountEntry, "the funding seller must have a real COUPON_DISCOUNT entry");
  assert.equal(discountEntry.amountSantim, -2_000, "always negative — it comes out of the seller's own payout");

  const funderBalance = await getSellerBalance(fundingSeller);
  assert.equal(funderBalance.payableSantim, 9_000 - 2_000, "sale minus commission minus the coupon discount");

  const otherEntries = await listSellerLedgerEntries(otherSeller);
  assert.equal(otherEntries.length, 2, "the unrelated seller must have ONLY their normal SALE+COMMISSION, no discount entry at all");
  assert.ok(!otherEntries.some((e) => e.type === "COUPON_DISCOUNT"));
  const otherBalance = await getSellerBalance(otherSeller);
  assert.equal(otherBalance.payableSantim, 9_000, "an unrelated seller sharing the order must be completely unaffected");
});

test("a redelivered outbox message does not double-apply the COUPON_DISCOUNT entry", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const fundingSeller = await makeSeller(`coupon-redeliv-${suffix}`, 1000);
  const buyer = await prisma.user.create({ data: { email: `ledger-test-coupon-redeliv-buyer-${suffix}@example.et`, role: "CUSTOMER" } });

  const coupon = await prisma.coupon.create({
    data: { code: `LEDGERCPNREDELIV-${suffix}`, discountType: "FIXED_AMOUNT", discountValue: 1_000, sellerId: fundingSeller },
  });

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERCPNREDELIV${suffix}`.toUpperCase(),
      userId: buyer.id,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 5_000,
      discountSantim: 1_000,
      totalSantim: 4_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId: fundingSeller, sku: `CPNR-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 5_000, quantity: 1, lineTotalSantim: 5_000 },
        ],
      },
    },
  });
  await prisma.couponRedemption.create({
    data: { couponId: coupon.id, userId: buyer.id, orderId: order.id, discountSantim: 1_000 },
  });

  await createLedgerEntriesForOrder(order.id);
  await createLedgerEntriesForOrder(order.id); // the redelivery

  const entries = await listSellerLedgerEntries(fundingSeller);
  const discountEntries = entries.filter((e) => e.type === "COUPON_DISCOUNT");
  assert.equal(discountEntries.length, 1, "a redelivered message must not create a second discount entry");
});

test("an admin/platform-wide coupon redemption creates NO COUPON_DISCOUNT entry — the marketplace absorbs it, unchanged", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`coupon-admin-${suffix}`, 1000);
  const buyer = await prisma.user.create({ data: { email: `ledger-test-coupon-admin-buyer-${suffix}@example.et`, role: "CUSTOMER" } });

  const coupon = await prisma.coupon.create({
    data: { code: `LEDGERCPNADMIN-${suffix}`, discountType: "FIXED_AMOUNT", discountValue: 1_500 }, // sellerId null
  });

  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERCPNADMIN${suffix}`.toUpperCase(),
      userId: buyer.id,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 8_000,
      discountSantim: 1_500,
      totalSantim: 6_500,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `CPNA-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 8_000, quantity: 1, lineTotalSantim: 8_000 },
        ],
      },
    },
  });
  await prisma.couponRedemption.create({
    data: { couponId: coupon.id, userId: buyer.id, orderId: order.id, discountSantim: 1_500 },
  });

  await createLedgerEntriesForOrder(order.id);

  const entries = await listSellerLedgerEntries(sellerId);
  assert.equal(entries.length, 2, "only the normal SALE+COMMISSION — an admin coupon must never touch the seller's ledger");
  const balance = await getSellerBalance(sellerId);
  assert.equal(balance.payableSantim, 7_200, "8000 - 10% commission (800), completely unaffected by the platform-funded discount");
});

// getSellerBusinessMetrics is scoped to a single, freshly created test
// seller per test (a real, unique sellerId) — unlike admin-queries.ts's
// getBusinessMetrics, which aggregates across ALL sellers globally, there
// is no cross-file interference risk here even though node --test runs
// integration test files concurrently by default: no other test file can
// possibly attribute a sale to THIS seller's randomly generated id.
// Exact-equality assertions are safe.
test("getSellerBusinessMetrics computes real orders/gross-sales/top-products for one seller, within the window only", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`metrics-${suffix}`, 1000);

  await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERMETRICS-1-${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `M1-${suffix}`, productTitle: "Popular Item", variantTitle: "Default", unitPriceSantim: 5_000, quantity: 2, lineTotalSantim: 10_000 },
        ],
      },
    },
  });
  await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERMETRICS-2-${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 3_000,
      totalSantim: 3_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `M2-${suffix}`, productTitle: "Less Popular Item", variantTitle: "Default", unitPriceSantim: 3_000, quantity: 1, lineTotalSantim: 3_000 },
        ],
      },
    },
  });
  // An order outside the 30-day window — paidAt is backdated 60 days, so
  // it must not count toward anything.
  await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERMETRICS-OLD-${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 99_999,
      totalSantim: 99_999,
      paidAt: new Date(Date.now() - 60 * 24 * 60 * 60_000),
      lines: {
        create: [
          {
            sellerId,
            sku: `MOLD-${suffix}`,
            productTitle: "Old Item",
            variantTitle: "Default",
            unitPriceSantim: 99_999,
            quantity: 1,
            lineTotalSantim: 99_999,
          },
        ],
      },
    },
  });

  const metrics = await getSellerBusinessMetrics(sellerId);
  assert.equal(metrics.ordersCount, 2, "only the two real in-window orders — the 60-day-old one must be excluded");
  assert.equal(metrics.grossSalesSantim, 13_000, "10000 + 3000, the 99999 old order must not be included");
  assert.equal(metrics.topProducts.length, 2);
  assert.equal(metrics.topProducts[0]!.productTitle, "Popular Item", "higher revenue must rank first");
  assert.equal(metrics.topProducts[0]!.unitsSold, 2);
  assert.equal(metrics.topProducts[0]!.revenueSantim, 10_000);
  assert.equal(metrics.topProducts[1]!.productTitle, "Less Popular Item");
});

test("getSellerBusinessMetrics for a seller with no real sales returns real zeros, not an error", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`metrics-empty-${suffix}`, 1000);

  const metrics = await getSellerBusinessMetrics(sellerId);
  assert.equal(metrics.ordersCount, 0);
  assert.equal(metrics.grossSalesSantim, 0);
  assert.equal(metrics.topProducts.length, 0);
  assert.equal(metrics.marginSantim, null, "no sales at all means nothing to report a margin on");
  assert.equal(metrics.unitsMissingCostData, 0);
});

// costSantim is snapshotted onto OrderLine by checkout-service.ts's
// placeOrder — untestable end-to-end in this environment for the same
// documented reason checkout-service.integration.test.ts's own module
// comment gives (env() + a real outbound gateway call on success), so
// these seed the real downstream state directly, the same way this
// file's other tests already create Order/OrderLine rows without going
// through placeOrder.
test("getSellerBusinessMetrics computes a real margin from lines with cost data, and reports units missing it honestly", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`metrics-margin-${suffix}`, 1000);

  await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERMARGIN-1-${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: new Date(),
      lines: {
        create: [
          // Sold for 100 each, cost 60 each, 2 units: 200 revenue, 120 cost, 80 margin.
          { sellerId, sku: `MG1-${suffix}`, productTitle: "Known Cost Item", variantTitle: "Default", unitPriceSantim: 10_000, quantity: 2, lineTotalSantim: 20_000, costSantim: 6_000 },
        ],
      },
    },
  });
  await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERMARGIN-2-${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 5_000,
      totalSantim: 5_000,
      paidAt: new Date(),
      lines: {
        create: [
          // No cost snapshot at all — must be excluded from the margin sum,
          // never silently treated as free (which would inflate margin).
          { sellerId, sku: `MG2-${suffix}`, productTitle: "Unknown Cost Item", variantTitle: "Default", unitPriceSantim: 5_000, quantity: 3, lineTotalSantim: 15_000, costSantim: null },
        ],
      },
    },
  });

  const metrics = await getSellerBusinessMetrics(sellerId);
  assert.equal(metrics.grossSalesSantim, 35_000, "gross sales must still include the no-cost-data line");
  assert.equal(metrics.marginSantim, 8_000, "20000 revenue - 12000 cost (6000 x 2) from the known-cost line only");
  assert.equal(metrics.unitsMissingCostData, 3, "the 3 units with no cost snapshot, honestly disclosed");
});

// listSellersWithPayableBalance is a GLOBAL query across every seller —
// same real cross-file interference risk under node --test's concurrent
// execution that admin-queries.ts's getBusinessMetrics already needed a
// workaround for. Finding this test's own unique sellerId within the
// returned array (rather than asserting on the array's overall length or
// order) sidesteps that entirely.
test("listSellersWithPayableBalance surfaces a real seller with a real positive balance, with the real correct amount", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`payable-${suffix}`, 1000);
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERPAYABLE${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 20_000,
      totalSantim: 20_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `PAY-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 20_000, quantity: 1, lineTotalSantim: 20_000 },
        ],
      },
    },
  });
  await createLedgerEntriesForOrder(order.id);

  const sellers = await listSellersWithPayableBalance();
  const mine = sellers.find((s) => s.sellerId === sellerId);
  assert.ok(mine, "a seller with a real positive unsettled balance must appear in the payouts queue");
  assert.equal(mine!.payableSantim, 18_000, "20000 - 10% commission (2000)");
});

test("listSellersWithPayableBalance excludes a seller whose balance is exactly zero", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`payable-zero-${suffix}`, 1000);

  const sellers = await listSellersWithPayableBalance();
  assert.ok(!sellers.some((s) => s.sellerId === sellerId), "a seller with no ledger entries at all has nothing owed, must not appear");
});

test("recordSellerPayout settles the real full current balance, and getSellerBalance reflects it as settled afterward", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`payout-${suffix}`, 1000);
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERPAYOUT${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 15_000,
      totalSantim: 15_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `PO-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 15_000, quantity: 1, lineTotalSantim: 15_000 },
        ],
      },
    },
  });
  await createLedgerEntriesForOrder(order.id);

  const before = await getSellerBalance(sellerId);
  assert.equal(before.payableSantim, 13_500);
  assert.equal(before.settledSantim, 0);

  const result = await recordSellerPayout(sellerId);
  assert.equal(result.settledSantim, 13_500);
  assert.equal(result.entriesCount, 2, "the real SALE and COMMISSION entries, both settled together");

  const after = await getSellerBalance(sellerId);
  assert.equal(after.payableSantim, 0, "the settled entries must no longer count as still owed");
  assert.equal(after.settledSantim, 13_500);
  assert.equal(after.lifetimeNetSantim, 13_500, "lifetime net must be unaffected by settling — it was always real money owed either way");
});

test("recordSellerPayout on a seller with nothing owed is rejected, not a silent no-op", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`payout-empty-${suffix}`, 1000);

  await assert.rejects(
    () => recordSellerPayout(sellerId),
    (err: unknown) => err instanceof SettlementError && /nothing owed/i.test(err.message),
  );
});

test("calling recordSellerPayout twice in a row is rejected the second time — a payout must never be recorded twice for the same balance", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`payout-twice-${suffix}`, 1000);
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-LEDGERPAYOUTTWICE${suffix}`.toUpperCase(),
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 5_000,
      totalSantim: 5_000,
      paidAt: new Date(),
      lines: {
        create: [
          { sellerId, sku: `POT-${suffix}`, productTitle: "Item", variantTitle: "Default", unitPriceSantim: 5_000, quantity: 1, lineTotalSantim: 5_000 },
        ],
      },
    },
  });
  await createLedgerEntriesForOrder(order.id);

  await recordSellerPayout(sellerId);
  await assert.rejects(() => recordSellerPayout(sellerId), SettlementError);
});

test.after(async () => {
  await prisma.couponRedemption.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-LEDGER" } } } });
  await prisma.coupon.deleteMany({ where: { code: { startsWith: "LEDGERCPN" } } });
  await prisma.sellerLedgerEntry.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-LEDGER" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-LEDGER" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-LEDGER" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "ledger-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "ledger-test-" } } });
  await prisma.$disconnect();
});
