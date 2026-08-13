/**
 * Background worker — the half of the payment system nobody demos.
 *
 * Four loops, each with a distinct job:
 *
 *   settle      poll intents that SantimPay has not resolved yet
 *   reconcile   sweep everything still unresolved after an hour (the safety net)
 *   expire      release stock held by abandoned checkouts
 *   outbox      publish side effects written transactionally with state changes
 *
 * WHY THIS PROCESS EXISTS
 * A webhook-only integration WILL leak stuck orders: callbacks get dropped by
 * proxies, blocked by a bad deploy, or lost when the gateway has an incident.
 * The poller covers minutes; the reconciler covers everything else. Together
 * they turn "the customer's money vanished" into "resolved automatically in
 * under an hour".
 *
 * Run as a separate container from the web app: its failure modes, scaling
 * profile, and deploy cadence are all different.
 */

import http from "node:http";
import { prisma } from "../server/db.js";
import { logger } from "../server/observability/logger.js";
import { settlePayment } from "../server/payments/payment-service.js";
import { env } from "../server/config/env.js";
import { nextPollDelaySeconds } from "../server/orders/state-machine.js";
import { registry, reservationsExpiredTotal, stuckPaymentsGauge } from "../server/observability/metrics.js";
// Imported from session-store.ts specifically, NOT session.ts — session.ts
// imports next/headers, which fails to resolve entirely outside Next's own
// request pipeline. The worker is a plain Node process, so even an unused
// import of that module would crash it at startup. See session-store.ts's
// module comment.
import { purgeExpiredSessions } from "../server/auth/session-store.js";

const TICK_MS = 5_000;
const RECONCILE_EVERY_MS = 15 * 60_000;
const BATCH = 25;
const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT ?? 9091);

let running = true;
let inFlight = 0;

/* ------------------------------------------------------------ settle loop */

async function settleDuePayments(): Promise<void> {
  const due = await prisma.paymentIntent.findMany({
    where: {
      status: { in: ["CREATED", "PENDING"] },
      nextPollAt: { lte: new Date() },
    },
    orderBy: { nextPollAt: "asc" },
    take: BATCH,
  });

  for (const intent of due) {
    try {
      const result = await settlePayment(intent.merchantTxnId, "poller");

      if (result.changed && result.status !== "PENDING") continue; // resolved

      const delay = nextPollDelaySeconds(intent.pollAttempts + 1);

      if (delay === null) {
        // We have waited out the whole window. Mark EXPIRED so a human sees it —
        // but note the state machine still allows EXPIRED -> COMPLETED, because
        // the gateway does not know about our deadline and may resolve later.
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "EXPIRED", nextPollAt: null, lastPolledAt: new Date() },
        });
        logger.warn("payment.expired", {
          merchantTxnId: intent.merchantTxnId,
          orderId: intent.orderId,
          attempts: intent.pollAttempts,
        });
        continue;
      }

      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          pollAttempts: { increment: 1 },
          lastPolledAt: new Date(),
          nextPollAt: new Date(Date.now() + delay * 1000),
        },
      });
    } catch (error) {
      // One bad intent must never stop the loop. Back off and keep going.
      logger.error("worker.settle_failed", {
        merchantTxnId: intent.merchantTxnId,
        error: (error as Error).message,
      });
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          pollAttempts: { increment: 1 },
          lastPolledAt: new Date(),
          nextPollAt: new Date(Date.now() + 60_000),
        },
      });
    }
  }
}

/* -------------------------------------------------------- reconcile sweep */

async function reconcile(): Promise<void> {
  // Housekeeping unrelated to payments piggybacks on this same 15-minute
  // cadence rather than getting its own interval — expired sessions are low
  // urgency (an expired token already fails `getSessionUser()`'s expiry
  // check on every request; this only reclaims the row) and don't need a
  // tighter loop of their own.
  const purged = await purgeExpiredSessions();
  if (purged > 0) logger.info("sessions.purged", { count: purged });

  const cutoff = new Date(Date.now() - 60 * 60_000);
  const stragglers = await prisma.paymentIntent.findMany({
    where: {
      status: { in: ["CREATED", "PENDING", "EXPIRED"] },
      createdAt: { lt: cutoff },
    },
    take: 200,
  });

  if (stragglers.length === 0) return;

  logger.warn("reconciler.sweep", { count: stragglers.length });

  for (const intent of stragglers) {
    try {
      await settlePayment(intent.merchantTxnId, "reconciler");
    } catch (error) {
      logger.error("reconciler.failed", {
        merchantTxnId: intent.merchantTxnId,
        error: (error as Error).message,
      });
    }
  }
}

/* ------------------------------------------------------ reservation expiry */

async function expireReservations(): Promise<void> {
  const expired = await prisma.inventoryReservation.findMany({
    where: { status: "HELD", expiresAt: { lt: new Date() } },
    take: 200,
  });

  for (const reservation of expired) {
    // Each release is its own transaction: one failure must not block the rest.
    await prisma.$transaction([
      prisma.inventory.update({
        where: { variantId: reservation.variantId },
        data: { reserved: { decrement: reservation.quantity } },
      }),
      prisma.inventoryReservation.update({
        where: { id: reservation.id },
        data: { status: "RELEASED" },
      }),
    ]);
  }

  if (expired.length > 0) {
    logger.info("reservations.expired", { count: expired.length });
    reservationsExpiredTotal.inc(expired.length);
  }
}

/* -------------------------------------------------------------- gauges */

/** Refresh point-in-time gauges. Cheap enough to run every tick. */
async function refreshGauges(): Promise<void> {
  const unresolved = await prisma.paymentIntent.count({
    where: { status: { in: ["CREATED", "PENDING", "EXPIRED"] } },
  });
  stuckPaymentsGauge.set(unresolved);
}

/* ------------------------------------------------------- outbox publisher */

async function publishOutbox(): Promise<void> {
  const messages = await prisma.outboxMessage.findMany({
    where: { publishedAt: null, availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  for (const message of messages) {
    try {
      await deliver(message.topic, message.payload);
      await prisma.outboxMessage.update({
        where: { id: message.id },
        data: { publishedAt: new Date() },
      });
    } catch (error) {
      const attempts = message.attempts + 1;
      // Exponential backoff, capped. After ~10 attempts it needs a human, and
      // the dashboard query for "unpublished older than 1h" will surface it.
      const backoffMs = Math.min(2 ** attempts * 1000, 30 * 60_000);
      await prisma.outboxMessage.update({
        where: { id: message.id },
        data: {
          attempts,
          lastError: (error as Error).message.slice(0, 1000),
          availableAt: new Date(Date.now() + backoffMs),
        },
      });
      logger.error("outbox.delivery_failed", {
        topic: message.topic,
        attempts,
        error: (error as Error).message,
      });
    }
  }
}

/** Replace with real senders (email, SMS, search reindex) as you build them. */
async function deliver(topic: string, payload: unknown): Promise<void> {
  logger.info("outbox.delivered", { topic, payload });
}

/* ------------------------------------------------------------------ runtime */

async function tick(): Promise<void> {
  inFlight++;
  try {
    await settleDuePayments();
    await expireReservations();
    await publishOutbox();
    await refreshGauges();
  } finally {
    inFlight--;
  }
}

/**
 * The worker's own tiny metrics server.
 *
 * NOT the same mechanism as the web app's `/api/metrics` (see that route's
 * comment for why it needs a bearer token): this port is never fronted by an
 * Ingress or LoadBalancer at all — it exists purely for pod-to-pod scraping
 * inside the cluster, restricted by the NetworkPolicy in infra/k8s to the
 * monitoring namespace. No public exposure, so no token to check.
 */
function startMetricsServer(): void {
  const server = http.createServer((request, response) => {
    if (request.url === "/metrics") {
      registry.metrics().then((body) => {
        response.writeHead(200, { "Content-Type": registry.contentType });
        response.end(body);
      }).catch((error: unknown) => {
        response.writeHead(500);
        response.end(String(error));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(METRICS_PORT, () => {
    logger.info("worker.metrics_listening", { port: METRICS_PORT });
  });
}

async function main(): Promise<void> {
  env(); // fail fast on bad configuration, before any work
  startMetricsServer();
  logger.info("worker.started", { tickMs: TICK_MS });

  let lastReconcile = 0;

  while (running) {
    try {
      await tick();
      if (Date.now() - lastReconcile > RECONCILE_EVERY_MS) {
        await reconcile();
        lastReconcile = Date.now();
      }
    } catch (error) {
      logger.error("worker.tick_failed", { error: (error as Error).message });
    }
    await sleep(TICK_MS);
  }

  // Graceful shutdown: finish the current tick before exiting, so we never
  // leave a settlement half-applied. Kubernetes sends SIGTERM and waits
  // terminationGracePeriodSeconds before SIGKILL — this is what makes that wait
  // meaningful rather than decorative.
  while (inFlight > 0) await sleep(100);
  await prisma.$disconnect();
  logger.info("worker.stopped");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info("worker.shutdown_requested", { signal });
    running = false;
  });
}

main().catch((error) => {
  logger.error("worker.fatal", { error: (error as Error).message });
  process.exit(1);
});
