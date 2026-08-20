/**
 * Integration test — requires a real Postgres, not a mock.
 *
 * Curriculum Phase 12 §2 / Lab 12.2's own claim, proven the same way
 * `reservation.integration.test.ts` proves oversell-prevention: a mocked
 * Prisma client cannot prove this — the safety mechanism IS Postgres's own
 * unique-constraint enforcement under concurrent writers, which a mock has
 * no way to replicate faithfully. Only hitting a real database is evidence.
 *
 * Run (or just `pnpm test:integration`, which runs every *.integration.test.ts
 * this same way):
 *   docker compose up -d postgres
 *   DATABASE_URL=postgresql://santim:santim@localhost:5432/santim_commerce pnpm exec prisma migrate deploy
 *   DATABASE_URL=postgresql://santim:santim@localhost:5432/santim_commerce \
 *     pnpm exec tsx --test src/server/shipping/label-service.integration.test.ts
 *
 * tsx, not `node --experimental-strip-types`: this file needs REAL,
 * runtime-resolved cross-file imports (`prisma` from `../db.js`, `logger`,
 * `generateLabel`) — unlike reservation.integration.test.ts, which only
 * imports a TYPE across files (erased entirely by type-stripping, never
 * actually resolved). See that file's own comment for the full reasoning;
 * this is the file that actually needed tsx, which is why the shared
 * `test:integration` script now uses it for both.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { generateShippingLabel } from "./label-service.ts";
import { _resetCarrierLedgerForTests } from "./carrier-client.ts";

const prisma = new PrismaClient();

async function makeOrder(): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const order = await prisma.order.create({
    data: {
      // Not truncated to 11 chars — see reservation.integration.test.ts's
      // own comment on this exact class of bug, copied here originally and
      // now fixed in both places: truncating after prefixing destroys most
      // of the random suffix's actual entropy.
      orderNumber: `SC-LBL${suffix}`.toUpperCase(),
      email: "label-test@example.et",
      phone: "+251900000000",
      subtotalSantim: 1999,
      totalSantim: 1999,
      status: "PAID",
    },
  });
  return order.id;
}

test("sequential calls for the same order return the identical label, not a new one", async () => {
  const orderId = await makeOrder();

  const first = await generateShippingLabel(orderId);
  const second = await generateShippingLabel(orderId);

  assert.equal(first.trackingNumber, second.trackingNumber);
  assert.equal(first.labelUrl, second.labelUrl);

  const rows = await prisma.shippingLabel.findMany({ where: { orderId } });
  assert.equal(rows.length, 1, "exactly one ShippingLabel row must exist for this order");
});

test(
  "50 concurrent generateShippingLabel calls for the SAME order: exactly one row, one carrier call",
  { timeout: 30_000 },
  async () => {
    const orderId = await makeOrder();

    const attempts = Array.from({ length: 50 }, () => generateShippingLabel(orderId));
    const results = await Promise.all(attempts);

    // Every caller must get back the SAME tracking number — proof the
    // carrier was never asked to mint a second, separately-billable label.
    const distinctTrackingNumbers = new Set(results.map((r) => r.trackingNumber));
    assert.equal(distinctTrackingNumbers.size, 1, `expected 1 distinct tracking number, got ${distinctTrackingNumbers.size}`);

    const rows = await prisma.shippingLabel.findMany({ where: { orderId } });
    assert.equal(rows.length, 1, "the unique constraint on orderId must prevent a second row, even under 50-way concurrency");
    assert.equal(rows[0]?.status, "GENERATED");
  },
);

test("a rate quote is safe to request repeatedly and returns a stable answer", async () => {
  const { getRateQuote } = await import("./carrier-client.ts");
  const input = { weightGrams: 2500, destinationZone: "ADDIS_ABABA" as const };

  const quotes = await Promise.all(Array.from({ length: 10 }, () => getRateQuote(input)));
  const distinctRates = new Set(quotes.map((q) => q.carrierRateCents));

  // Pure calculation: no state changed, no row was written — unlike label
  // generation, calling this any number of times is uneventful by design.
  assert.equal(distinctRates.size, 1, "a rate quote must be deterministic for identical input");
});

test.beforeEach(() => {
  _resetCarrierLedgerForTests();
});

test.after(async () => {
  // Mirrors reservation.integration.test.ts's own cleanup discipline: delete
  // by the same prefix used to generate the data, never a blanket wipe.
  //
  // Children before parent: ShippingLabel.order is onDelete: Restrict (see
  // schema.prisma's comment on why — it's a real, billable carrier
  // transaction, not disposable), so the database itself now refuses to
  // delete an Order that still has a label row pointing at it. That's the
  // guardrail working correctly, not a bug to work around — cleanup just
  // has to respect the same ordering real code would.
  await prisma.shippingLabel.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-LBL" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-LBL" } } });
  await prisma.$disconnect();
});
