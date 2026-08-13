/**
 * Order & payment state machines.
 *
 * WHY A STATE MACHINE INSTEAD OF `UPDATE orders SET status = $1`
 * --------------------------------------------------------------
 * Payment callbacks arrive out of order. A `PENDING` notification delayed by a
 * slow mobile network can land AFTER the `COMPLETED` one. A naive update
 * applies whichever arrived last and silently un-pays a paid order — and the
 * warehouse never ships.
 *
 * Declaring legal transitions makes that class of bug unrepresentable: a late
 * `PENDING` is rejected as illegal rather than applied. Every rejection is
 * logged, which also gives you a free signal for gateway misbehaviour.
 *
 * This module is deliberately PURE — no database, no network. That is what
 * makes the rules exhaustively testable in microseconds.
 */

export type OrderStatus =
  | "PENDING_PAYMENT"
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

export type PaymentStatus =
  | "CREATED"
  | "PENDING"
  | "COMPLETED"
  | "FAILED"
  | "DECLINED"
  | "EXPIRED"
  | "REFUNDED";

/** Legal payment transitions. Anything absent here is a bug or an attack. */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["PENDING", "COMPLETED", "FAILED", "DECLINED", "EXPIRED"],
  // A payment can complete straight from PENDING, fail, or time out.
  PENDING: ["COMPLETED", "FAILED", "DECLINED", "EXPIRED"],
  // Terminal-with-one-exit: money can still be sent back.
  COMPLETED: ["REFUNDED"],
  FAILED: [],
  DECLINED: [],
  // A payment we gave up on can still resolve late — the gateway does not know
  // about our deadline. Allowing EXPIRED -> COMPLETED is what lets the nightly
  // reconciler heal an order rather than leaving a customer charged and empty-handed.
  EXPIRED: ["COMPLETED", "FAILED"],
  REFUNDED: [],
};

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ["PAID", "FAILED", "CANCELLED"],
  PAID: ["REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED"],
  FAILED: ["PENDING_PAYMENT", "CANCELLED"], // customer may retry with another channel
  CANCELLED: [],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  REFUNDED: [],
};

export class IllegalTransitionError extends Error {
  override name = "IllegalTransitionError";
  readonly entity: "order" | "payment";
  readonly from: string;
  readonly to: string;
  readonly subjectId: string;

  // NOTE: written out longhand rather than using TypeScript parameter
  // properties (`constructor(readonly from: string)`). Parameter properties
  // EMIT code, so they cannot be erased — which means Node's built-in
  // type-stripping refuses the file, and this module has to run unbuilt in
  // tests and in the worker. A small syntax cost for zero build tooling.
  constructor(entity: "order" | "payment", from: string, to: string, subjectId: string) {
    super(
      `Illegal ${entity} transition ${from} -> ${to} for ${subjectId}. ` +
        `This usually means an out-of-order or replayed callback; it is ignored, not applied.`,
    );
    this.entity = entity;
    this.from = from;
    this.to = to;
    this.subjectId = subjectId;
  }
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Decide what to do with an incoming status.
 *
 * Returns an explicit decision rather than throwing, because "this transition
 * is not legal" is a NORMAL, expected event in webhook processing — the second
 * delivery of an already-processed callback. Throwing on the normal path makes
 * logs useless and tempts people to catch-and-ignore.
 */
export type TransitionDecision =
  | { action: "apply"; from: PaymentStatus; to: PaymentStatus }
  | { action: "ignore"; reason: "already-in-state" | "terminal" | "out-of-order"; from: PaymentStatus; to: PaymentStatus };

export function decidePaymentTransition(
  current: PaymentStatus,
  incoming: PaymentStatus,
): TransitionDecision {
  if (current === incoming) {
    return { action: "ignore", reason: "already-in-state", from: current, to: incoming };
  }
  if (canTransitionPayment(current, incoming)) {
    return { action: "apply", from: current, to: incoming };
  }
  return {
    action: "ignore",
    reason: SETTLED_STATUSES.includes(current) ? "terminal" : "out-of-order",
    from: current,
    to: incoming,
  };
}

/**
 * States in which the money question is answered.
 *
 * Declared explicitly rather than inferred from "has no legal exits", because
 * COMPLETED *does* have an exit (REFUNDED) yet is absolutely settled. The
 * distinction matters operationally: "terminal" in a log line means "a late
 * callback arrived for a decided payment — normal, ignore it", whereas
 * "out-of-order" means "the gateway sent us something we cannot place — look".
 */
const SETTLED_STATUSES: readonly PaymentStatus[] = [
  "COMPLETED",
  "FAILED",
  "DECLINED",
  "REFUNDED",
];

export function isSettled(status: PaymentStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

/** The order status implied by a payment reaching a given state. */
export function orderStatusForPayment(payment: PaymentStatus): OrderStatus | null {
  switch (payment) {
    case "COMPLETED":
      return "PAID";
    case "FAILED":
    case "DECLINED":
      return "FAILED";
    case "EXPIRED":
      return "CANCELLED";
    case "REFUNDED":
      return "REFUNDED";
    case "CREATED":
    case "PENDING":
      return null; // no order-level change while in flight
  }
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus, orderId: string): void {
  if (from === to) return;
  if (!canTransitionOrder(from, to)) {
    throw new IllegalTransitionError("order", from, to, orderId);
  }
}

/**
 * Poll schedule for a payment that has not resolved.
 *
 * Backoff exists because the customer is standing at a Telebirr prompt: the
 * first few seconds matter for perceived speed, the next few minutes are just
 * patience, and after 30 minutes a human or the nightly reconciler should own
 * it rather than a tight loop.
 *
 * Returns null when we should stop polling and mark the intent EXPIRED.
 */
const POLL_SCHEDULE_SECONDS = [5, 10, 20, 30, 60, 120, 300, 300, 600, 600, 900] as const;

export function nextPollDelaySeconds(attempt: number): number | null {
  return POLL_SCHEDULE_SECONDS[attempt] ?? null;
}

export function totalPollWindowSeconds(): number {
  return POLL_SCHEDULE_SECONDS.reduce((a, b) => a + b, 0);
}
