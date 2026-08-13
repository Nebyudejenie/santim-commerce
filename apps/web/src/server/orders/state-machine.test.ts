/**
 * State machine tests.
 *
 * These are the cheapest, highest-value tests in the codebase: pure functions,
 * no database, microseconds to run — and they encode the rules that stop a
 * paid order from being un-paid by a late callback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  IllegalTransitionError,
  assertOrderTransition,
  canTransitionPayment,
  decidePaymentTransition,
  nextPollDelaySeconds,
  orderStatusForPayment,
  totalPollWindowSeconds,
  type PaymentStatus,
} from "./state-machine.ts";

test("the happy path is legal", () => {
  assert.equal(canTransitionPayment("CREATED", "PENDING"), true);
  assert.equal(canTransitionPayment("PENDING", "COMPLETED"), true);
  assert.equal(canTransitionPayment("COMPLETED", "REFUNDED"), true);
});

test("a completed payment can never go back to pending", () => {
  // THE bug this whole module exists to prevent: a PENDING callback delayed by
  // a slow network arriving after the COMPLETED one, un-paying a paid order.
  const decision = decidePaymentTransition("COMPLETED", "PENDING");
  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "terminal");
});

test("a completed payment cannot be failed by a late callback", () => {
  assert.equal(decidePaymentTransition("COMPLETED", "FAILED").action, "ignore");
  assert.equal(canTransitionPayment("COMPLETED", "FAILED"), false);
});

test("a duplicate callback in the same state is a no-op, not an error", () => {
  const decision = decidePaymentTransition("COMPLETED", "COMPLETED");
  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "already-in-state");
});

test("an expired payment can still complete — the gateway ignores our deadline", () => {
  // Without this edge, a customer whose Telebirr confirmation took 45 minutes
  // is charged and never fulfilled. The reconciler depends on it.
  const decision = decidePaymentTransition("EXPIRED", "COMPLETED");
  assert.equal(decision.action, "apply");
});

test("terminal failure states are absorbing", () => {
  for (const terminal of ["FAILED", "DECLINED", "REFUNDED"] as PaymentStatus[]) {
    for (const target of ["PENDING", "COMPLETED", "FAILED"] as PaymentStatus[]) {
      if (target === terminal) continue;
      assert.equal(
        canTransitionPayment(terminal, target),
        false,
        `${terminal} -> ${target} must be illegal`,
      );
    }
  }
});

test("every payment state maps to an order status or explicitly to none", () => {
  assert.equal(orderStatusForPayment("COMPLETED"), "PAID");
  assert.equal(orderStatusForPayment("FAILED"), "FAILED");
  assert.equal(orderStatusForPayment("DECLINED"), "FAILED");
  assert.equal(orderStatusForPayment("EXPIRED"), "CANCELLED");
  assert.equal(orderStatusForPayment("REFUNDED"), "REFUNDED");
  // In-flight states must NOT move the order — that is what keeps the customer
  // from seeing "failed" while their payment is still being approved.
  assert.equal(orderStatusForPayment("CREATED"), null);
  assert.equal(orderStatusForPayment("PENDING"), null);
});

test("order transitions reject the impossible", () => {
  assert.doesNotThrow(() => assertOrderTransition("PENDING_PAYMENT", "PAID", "o-1"));
  assert.doesNotThrow(() => assertOrderTransition("PAID", "REFUNDED", "o-1"));
  // A customer whose first attempt failed may retry with another channel.
  assert.doesNotThrow(() => assertOrderTransition("FAILED", "PENDING_PAYMENT", "o-1"));

  assert.throws(() => assertOrderTransition("CANCELLED", "PAID", "o-1"), IllegalTransitionError);
  assert.throws(() => assertOrderTransition("REFUNDED", "PAID", "o-1"), IllegalTransitionError);
});

test("a same-state order transition is a no-op", () => {
  assert.doesNotThrow(() => assertOrderTransition("PAID", "PAID", "o-1"));
});

test("the poll schedule backs off and then gives up", () => {
  assert.equal(nextPollDelaySeconds(0), 5);
  assert.ok(nextPollDelaySeconds(1)! >= nextPollDelaySeconds(0)!);
  assert.equal(nextPollDelaySeconds(999), null);

  // The window must be long enough for a slow bank rail but short enough that
  // a human hears about it the same day.
  const window = totalPollWindowSeconds();
  assert.ok(window > 30 * 60, `poll window ${window}s is too short for bank rails`);
  assert.ok(window < 2 * 60 * 60, `poll window ${window}s is too long to wait on`);
});
