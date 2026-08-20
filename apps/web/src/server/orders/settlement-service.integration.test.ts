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
import { createLedgerEntriesForOrder, getSellerBalance, listSellerLedgerEntries } from "./settlement-service.ts";

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

test.after(async () => {
  await prisma.sellerLedgerEntry.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-LEDGER" } } } });
  await prisma.orderLine.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-LEDGER" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-LEDGER" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "ledger-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "ledger-test-" } } });
  await prisma.$disconnect();
});
