/**
 * CHAOS DRILL: checkout transaction atomicity under a mid-flight database
 * connection kill.
 *
 * Proves checkout-service.ts's placeOrder() transaction is genuinely atomic
 * by severing the database connection MID-TRANSACTION — not simulating it,
 * actually doing it — and verifying nothing partial survives.
 *
 * TIMING TECHNIQUE: a naive approach races a `pg_stat_activity` polling loop
 * against the transaction's own completion. On localhost that's a coin
 * flip — a small transaction finishes in single-digit milliseconds, faster
 * than a poll-and-kill loop can react. This script instead DELIBERATELY
 * STALLS the transaction: a second connection takes a `SELECT ... FOR
 * UPDATE` row lock on the first inventory row `reserveForOrder()`'s
 * sorted-by-variantId loop will try to update, so placeOrder()'s own UPDATE
 * genuinely blocks waiting for that lock — a real, observable, unhurried
 * window. Once confirmed blocked, its backend PID is found and killed with
 * unlimited time budget, then the monitor's own lock is released.
 *
 * This is a repeatable regression check, not a one-off: run it again after
 * any change to placeOrder()'s transaction body to confirm atomicity still
 * holds. It creates and cleans up its own test data — safe to run against
 * any environment with a disposable catalogue (never against production).
 *
 * Usage: pnpm run chaos:checkout-atomicity
 */

import { PrismaClient } from "@prisma/client";
import { placeOrder } from "../src/server/checkout/checkout-service.ts";
import { prisma as appPrisma } from "../src/server/db.ts";

const CHAOS_EMAIL = "chaos-drill@example.et";
const monitor = new PrismaClient();

async function setupCart(): Promise<string> {
  const variants = await appPrisma.variant.findMany({ take: 8 });
  if (variants.length < 2) {
    throw new Error("Need at least 2 seeded variants to run this drill — run `pnpm run db:seed` first.");
  }
  const cart = await appPrisma.cart.create({
    data: {
      token: `chaos-drill-${Date.now()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lines: {
        create: variants.map((v) => ({ variantId: v.id, quantity: 1, unitPriceSantim: v.priceSantim })),
      },
    },
  });
  return cart.token;
}

async function cleanup(cartToken: string): Promise<void> {
  await appPrisma.order.deleteMany({ where: { email: CHAOS_EMAIL } });
  await appPrisma.cart.deleteMany({ where: { token: cartToken } });
  await appPrisma.inventoryReservation.deleteMany({ where: { orderId: null, status: "HELD" } });
}

async function main(): Promise<boolean> {
  const cartToken = await setupCart();
  console.log(`Test cart created: ${cartToken}`);

  try {
    const cartBefore = await appPrisma.cart.findUniqueOrThrow({
      where: { token: cartToken },
      include: { lines: true },
    });

    const sortedVariantIds = cartBefore.lines.map((l) => l.variantId).sort((a, b) => a.localeCompare(b));
    const firstVariantId = sortedVariantIds[0]!;

    const inventoryBefore = await appPrisma.inventory.findMany({
      where: { variantId: { in: cartBefore.lines.map((l) => l.variantId) } },
    });

    // 1. Take the blocking lock, in our OWN uncommitted transaction, and hold it.
    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolveLockHeld) => {
      monitor.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT * FROM "inventory" WHERE "variantId" = ${firstVariantId} FOR UPDATE`;
        resolveLockHeld();
        await new Promise<void>((resolveRelease) => {
          releaseLock = resolveRelease;
        });
      }).catch((err) => console.error("monitor transaction error:", err));
    });
    await lockHeld;
    console.log("Lock acquired — placeOrder()'s UPDATE will now block on it.");

    // 2. Start placeOrder(). It WILL block inside reserveForOrder's UPDATE.
    const placeOrderPromise = placeOrder({
      cartToken,
      email: CHAOS_EMAIL,
      phone: "0912345678",
      shippingZone: "ADDIS_ABABA",
      shippingAddress: { fullName: "Chaos Drill", city: "Addis Ababa", streetLine: "Bole" },
    });

    // 3. Confirm it's genuinely blocked, then kill its backend. No race —
    //    as long as our lock is held, its backend stays 'active' and
    //    waiting, so there is no rush to find and kill it.
    await new Promise((r) => setTimeout(r, 300));

    const blocked = await monitor.$queryRaw<Array<{ pid: number; query: string }>>`
      SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;

    let killed = false;
    for (const row of blocked) {
      if (row.query.toLowerCase().includes('update "inventory"')) {
        await monitor.$queryRaw`SELECT pg_terminate_backend(${row.pid}::int)`;
        killed = true;
      }
    }
    releaseLock?.();

    if (!killed) {
      console.error("FAIL: never observed placeOrder() blocked on the lock — drill inconclusive, not a pass.");
      return false;
    }
    console.log("Killed the transaction's backend while it was blocked mid-UPDATE.");

    const [placeOrderResult] = await Promise.allSettled([placeOrderPromise]);
    const rejected = placeOrderResult.status === "rejected";
    console.log(`placeOrder() ${rejected ? "correctly rejected" : "UNEXPECTEDLY SUCCEEDED"}`);

    await new Promise((r) => setTimeout(r, 500));

    const cartAfter = await appPrisma.cart.findUniqueOrThrow({ where: { token: cartToken } });
    const orphanOrders = await appPrisma.order.findMany({ where: { email: CHAOS_EMAIL } });
    const inventoryAfter = await appPrisma.inventory.findMany({
      where: { variantId: { in: cartBefore.lines.map((l) => l.variantId) } },
    });
    const reservedUnchanged = inventoryBefore.every((before) => {
      const after = inventoryAfter.find((a) => a.variantId === before.variantId);
      return after && after.reserved === before.reserved;
    });
    const orphanReservations = await appPrisma.inventoryReservation.findMany({
      where: { variantId: { in: cartBefore.lines.map((l) => l.variantId) }, orderId: null, status: "HELD" },
    });

    console.log(`Cart still ACTIVE: ${cartAfter.status === "ACTIVE"}`);
    console.log(`Zero orders created: ${orphanOrders.length === 0}`);
    console.log(`Inventory reservation counts unchanged: ${reservedUnchanged}`);
    console.log(`Zero orphaned reservations: ${orphanReservations.length === 0}`);

    const pass = rejected && cartAfter.status === "ACTIVE" && orphanOrders.length === 0
      && reservedUnchanged && orphanReservations.length === 0;
    console.log(`\n${pass ? "PASS" : "FAIL"}: checkout transaction ${pass ? "is" : "is NOT"} atomic under a mid-flight connection kill.`);
    return pass;
  } finally {
    await cleanup(cartToken);
  }
}

main()
  .then((pass) => process.exit(pass ? 0 : 1))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  })
  .finally(async () => {
    await monitor.$disconnect();
    await appPrisma.$disconnect();
  });
