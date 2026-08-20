/**
 * Integration test — requires a real Postgres, not a mock.
 *
 * This is the test the curriculum's Phase 3 gate demands: "200 concurrent
 * buyers, 1 unit in stock → exactly one sells." A mocked Prisma client cannot
 * prove this — mocks do not have Postgres's row-locking behaviour, which is
 * the entire mechanism the code relies on (see reservation.ts's module
 * comment). Only hitting a real database is evidence.
 *
 * Run (or just `pnpm test:integration`, which runs every *.integration.test.ts
 * this same way):
 *   docker compose up -d postgres
 *   DATABASE_URL=postgresql://santim:santim@localhost:5432/santim_commerce pnpm exec prisma migrate deploy
 *   DATABASE_URL=postgresql://santim:santim@localhost:5432/santim_commerce \
 *     pnpm exec tsx --test src/server/inventory/reservation.integration.test.ts
 *
 * tsx, not `node --experimental-strip-types`: this file only survives under
 * plain Node because its own cross-file import (`../db.js`) is `import type`
 * — fully erased by type-stripping, never actually resolved at runtime.
 * label-service.integration.test.ts needs REAL cross-file value imports
 * (`prisma`, `logger`, `generateLabel`), which type-stripping cannot resolve
 * (`.js` pointing at a `.ts` file is a TypeScript "Bundler"-moduleResolution
 * convention tsx understands and plain Node does not — see next.config.ts's
 * own comment on the identical gap for webpack). `test:integration` runs
 * both files with the same command, so it has to be the one that works for
 * both — tsx is a strict superset here, verified by re-running this file's
 * own five tests under it before switching the shared script over.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { InsufficientStockError, reserveForOrder } from "./reservation.ts";

const prisma = new PrismaClient();

async function makeVariant(onHand: number, allowBackorder = false) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const product = await prisma.product.create({
    data: {
      slug: `race-test-${suffix}`,
      title: "Race Test Product",
      description: "created by reservation.integration.test.ts",
      status: "ACTIVE",
    },
  });
  const variant = await prisma.variant.create({
    data: {
      productId: product.id,
      sku: `RACE-${suffix}`,
      title: "Default",
      priceSantim: 1999,
    },
  });
  await prisma.inventory.create({
    data: { variantId: variant.id, onHand, reserved: 0, allowBackorder },
  });
  return variant.id;
}

async function makeOrderShell() {
  const suffix = Math.random().toString(36).slice(2, 10);
  const order = await prisma.order.create({
    data: {
      // NOT sliced to 11 chars the way a real order-number.ts value would
      // be: `SC-TEST` (7 chars) + an 11-char slice left only 4 characters
      // of real randomness — a ~1.68M keyspace that a few hundred orders
      // per run, across many CI runs, can actually collide in (confirmed
      // for real: this exact collision failed a live CI run, on
      // "orders_orderNumber_key", nothing to do with whatever else that
      // run was testing). Keep the full random suffix instead.
      orderNumber: `SC-TEST${suffix}`.toUpperCase(),
      email: "race@example.et",
      phone: "+251900000000",
      subtotalSantim: 1999,
      totalSantim: 1999,
    },
  });
  return order.id;
}

/** Attempt one reservation in its own transaction, exactly as production code does. */
async function attemptReservation(variantId: string, quantity: number): Promise<"granted" | "denied"> {
  const orderId = await makeOrderShell();
  try {
    await prisma.$transaction(async (tx) => {
      await reserveForOrder(tx, orderId, [{ variantId, quantity }], new Date(Date.now() + 60_000));
    });
    return "granted";
  } catch (error) {
    if (error instanceof InsufficientStockError) return "denied";
    throw error;
  }
}

test("200 concurrent buyers, 1 unit in stock: exactly one wins", { timeout: 30_000 }, async () => {
  const variantId = await makeVariant(1);

  const attempts = Array.from({ length: 200 }, () => attemptReservation(variantId, 1));
  const results = await Promise.all(attempts);

  const granted = results.filter((r) => r === "granted").length;
  const denied = results.filter((r) => r === "denied").length;

  assert.equal(granted, 1, `expected exactly 1 grant, got ${granted}`);
  assert.equal(denied, 199, `expected exactly 199 denials, got ${denied}`);

  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  // The invariant that actually matters: reserved can never exceed onHand.
  // If the race were unhandled, this would read > 1.
  assert.equal(inventory.reserved, 1);
  assert.equal(inventory.onHand, 1);
});

test("50 concurrent buyers, 10 units in stock: exactly 10 win", { timeout: 30_000 }, async () => {
  const variantId = await makeVariant(10);

  const attempts = Array.from({ length: 50 }, () => attemptReservation(variantId, 1));
  const results = await Promise.all(attempts);

  assert.equal(results.filter((r) => r === "granted").length, 10);
  assert.equal(results.filter((r) => r === "denied").length, 40);

  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.reserved, 10);
});

test("multi-quantity requests are denied atomically, not partially", { timeout: 30_000 }, async () => {
  // 3 units left; a request for 5 must be entirely denied, never leave the
  // row at reserved=3 with a "partial" reservation record.
  const variantId = await makeVariant(3);

  const result = await attemptReservation(variantId, 5);
  assert.equal(result, "denied");

  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.reserved, 0, "a denied request must leave reserved untouched");
});

test("allowBackorder permits reserving past onHand", { timeout: 30_000 }, async () => {
  const variantId = await makeVariant(0, /* allowBackorder */ true);

  const result = await attemptReservation(variantId, 3);
  assert.equal(result, "granted");

  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  assert.equal(inventory.reserved, 3);
  assert.equal(inventory.onHand, 0);
});

test("deadlock-free acquisition: two orders buying the same two items in opposite order", { timeout: 30_000 }, async () => {
  // A is the lexicographically smaller of the two ids so both call sites end
  // up sorting into the SAME lock-acquisition order internally — this is what
  // reserveForOrder's sort-by-variantId is for. Without it, orderX taking
  // (A then B) while orderY takes (B then A) concurrently is a textbook
  // deadlock: Postgres detects it and kills one transaction with a 40P01
  // error, which would surface here as an unhandled rejection, not a clean
  // "denied" — the assertion below is really "this completed at all".
  const variantA = await makeVariant(5);
  const variantB = await makeVariant(5);

  const orderX = await makeOrderShell();
  const orderY = await makeOrderShell();

  const runX = prisma.$transaction((tx) =>
    reserveForOrder(tx, orderX, [
      { variantId: variantB, quantity: 1 }, // deliberately reversed vs runY
      { variantId: variantA, quantity: 1 },
    ], new Date(Date.now() + 60_000)),
  );
  const runY = prisma.$transaction((tx) =>
    reserveForOrder(tx, orderY, [
      { variantId: variantA, quantity: 1 },
      { variantId: variantB, quantity: 1 },
    ], new Date(Date.now() + 60_000)),
  );

  const settled = await Promise.allSettled([runX, runY]);
  assert.ok(
    settled.every((s) => s.status === "fulfilled"),
    `expected both orders to complete without a deadlock error: ${JSON.stringify(settled.map((s) => s.status === "rejected" ? String(s.reason) : "ok"))}`,
  );
});

test.after(async () => {
  // This test writes to a real, possibly shared, dev database. Leaving
  // "race-test-*" rows behind pollutes every catalogue query and product
  // count a developer runs afterward — exactly the kind of stray state the
  // top-level instructions warn against creating. Delete by the same prefix
  // used to generate the data, cascading through variant -> inventory ->
  // reservation via the schema's onDelete: Cascade.
  await prisma.product.deleteMany({ where: { slug: { startsWith: "race-test-" } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-TEST" } } });
  await prisma.$disconnect();
});
