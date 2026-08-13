/**
 * Application metrics — the RED/USE-method numbers the curriculum's Phase 9
 * (Observability & SRE) builds dashboards and alerts on top of.
 *
 * ONE REGISTRY, DEFINED ONCE. Every metric name and label set lives in this
 * file. The alternative — `new Counter(...)` scattered at each call site —
 * is how projects end up with three different metrics all meaning roughly
 * "a payment happened," none of which agree, and a Grafana dashboard nobody
 * trusts. Call sites only call the small `record*` functions below.
 *
 * Traces matter most for an integration like this one (see the curriculum),
 * but metrics are what pages someone at 3am — a trace tells you why checkout
 * is slow, a metric's burn-rate alert is what tells you to go look.
 */

import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

/* ------------------------------------------------------------- checkout */

export const ordersPlacedTotal = new client.Counter({
  name: "santim_orders_placed_total",
  help: "Orders successfully created, before payment resolves.",
  registers: [registry],
});

export const checkoutFailuresTotal = new client.Counter({
  name: "santim_checkout_failures_total",
  help: "Checkout attempts that failed before an order was created.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

/* --------------------------------------------------------------- payment */

export const checkoutSessionsTotal = new client.Counter({
  name: "santim_checkout_sessions_total",
  help: "SantimPay hosted checkout sessions created.",
  labelNames: ["outcome"] as const, // "created" | "duplicate_recovered" | "failed"
  registers: [registry],
});

export const paymentSettlementsTotal = new client.Counter({
  name: "santim_payment_settlements_total",
  help: "Payment state transitions applied, by trigger and resulting status.",
  labelNames: ["trigger", "status"] as const,
  registers: [registry],
});

export const paymentAmountMismatchTotal = new client.Counter({
  name: "santim_payment_amount_mismatch_total",
  help: "Callbacks where the gateway-reported amount disagreed with our records. Should always be zero — alert on >0.",
  registers: [registry],
});

/**
 * Duration of outbound calls to SantimPay itself, not our own request
 * handling — this is what tells you "the gateway is slow today" versus
 * "our checkout handler is slow today," a distinction that changes who gets
 * paged.
 */
export const santimpayRequestDuration = new client.Histogram({
  name: "santim_gateway_request_duration_seconds",
  help: "Latency of calls to the SantimPay API.",
  labelNames: ["operation", "outcome"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});

/* --------------------------------------------------------------- webhook */

export const webhookRequestsTotal = new client.Counter({
  name: "santim_webhook_requests_total",
  help: "Inbound SantimPay webhook deliveries, by result.",
  labelNames: ["result"] as const, // "accepted" | "duplicate" | "unauthorized" | "error"
  registers: [registry],
});

/* -------------------------------------------------------------- worker */

export const stuckPaymentsGauge = new client.Gauge({
  name: "santim_payments_unresolved",
  help: "Payment intents not yet resolved to a terminal state, refreshed each worker tick.",
  registers: [registry],
});

export const reservationsExpiredTotal = new client.Counter({
  name: "santim_inventory_reservations_expired_total",
  help: "Inventory reservations released because the checkout that held them was abandoned.",
  registers: [registry],
});

/** Wrap a SantimPay call to record duration + outcome in one place. */
export async function timeGatewayCall<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const stop = santimpayRequestDuration.startTimer({ operation });
  try {
    const result = await fn();
    stop({ outcome: "success" });
    return result;
  } catch (error) {
    stop({ outcome: "error" });
    throw error;
  }
}
