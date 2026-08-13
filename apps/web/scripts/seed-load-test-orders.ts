/**
 * Seeds a batch of orders purely for load-testing the order-status polling
 * endpoint (`/api/orders/:orderNumber/status`) — the one real users
 * genuinely hammer, since `OrderConfirmation` (see
 * apps/web/src/components/order-confirmation.tsx) polls it every 3s while a
 * payment is settling. A realistic load test needs real order numbers to
 * poll, in a realistic MIX of statuses (mostly still-pending, some resolved)
 * — not one row hit a thousand times, which would flatter Postgres's query
 * cache in a way production traffic never would.
 *
 * Deliberately separate from prisma/seed.ts: that script seeds the
 * CATALOGUE for actual demo use; this one exists only to support a load
 * test run and should never be pointed at a real environment.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/seed-load-test-orders.ts [count]
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prisma } from "../src/server/db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const COUNT = Number(process.argv[2] ?? 200);
// Mirrors real distribution: most orders a poller sees are still resolving;
// a minority have already reached a terminal state.
const STATUS_WEIGHTS: Array<[string, number]> = [
  ["PENDING_PAYMENT", 70],
  ["PAID", 20],
  ["FAILED", 10],
];

function pickStatus(): string {
  const total = STATUS_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [status, weight] of STATUS_WEIGHTS) {
    if (roll < weight) return status;
    roll -= weight;
  }
  return "PENDING_PAYMENT";
}

async function main() {
  const orderNumbers: string[] = [];

  for (let i = 0; i < COUNT; i++) {
    const status = pickStatus();
    const order = await prisma.order.create({
      data: {
        orderNumber: `SC-LOADTEST${i.toString().padStart(6, "0")}`,
        email: `loadtest-${i}@example.et`,
        phone: "+251900000000",
        status: status as never,
        subtotalSantim: 100_000,
        totalSantim: 100_000,
        paidAt: status === "PAID" ? new Date() : null,
      },
    });
    orderNumbers.push(order.orderNumber);
  }

  const fixturePath = join(__dirname, "../../../infra/load-testing/fixtures/order-numbers.json");
  writeFileSync(fixturePath, JSON.stringify(orderNumbers, null, 2));
  console.log(`Seeded ${orderNumbers.length} load-test orders -> ${fixturePath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
