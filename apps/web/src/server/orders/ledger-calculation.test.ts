import test from "node:test";
import assert from "node:assert/strict";
import { computeLedgerAmounts } from "./ledger-calculation.ts";

test("10% commission on a 10000 santim (100 ETB) sale", () => {
  const result = computeLedgerAmounts(10_000, 1000);
  assert.equal(result.saleSantim, 10_000);
  assert.equal(result.commissionSantim, -1_000);
  assert.equal(result.netPayableSantim, 9_000);
});

test("0% commission (a negotiated free tier) nets the full sale amount", () => {
  const result = computeLedgerAmounts(5_000, 0);
  assert.equal(result.commissionSantim, 0);
  assert.equal(result.netPayableSantim, 5_000);
});

test("100% commission (an edge case, not a real business scenario, but must not crash or go negative-of-negative)", () => {
  const result = computeLedgerAmounts(5_000, 10_000);
  assert.equal(result.commissionSantim, -5_000);
  assert.equal(result.netPayableSantim, 0);
});

test("rounds to the nearest whole santim, never a fraction", () => {
  // 999 * 1000 / 10000 = 99.9 -> rounds to 100
  const result = computeLedgerAmounts(999, 1000);
  assert.equal(result.commissionSantim, -100);
  assert.ok(Number.isInteger(result.commissionSantim));
  assert.ok(Number.isInteger(result.netPayableSantim));
});

test("sale + commission always sums to netPayable, for a range of realistic values", () => {
  for (const [amount, bps] of [[100, 250], [123_456, 999], [1, 10_000], [999_999, 1]] as const) {
    const result = computeLedgerAmounts(amount, bps);
    assert.equal(result.saleSantim + result.commissionSantim, result.netPayableSantim);
  }
});

test("rejects a non-integer or negative sale amount", () => {
  assert.throws(() => computeLedgerAmounts(10.5, 1000), RangeError);
  assert.throws(() => computeLedgerAmounts(-100, 1000), RangeError);
});

test("rejects a commissionBps outside [0, 10000]", () => {
  assert.throws(() => computeLedgerAmounts(1000, -1), RangeError);
  assert.throws(() => computeLedgerAmounts(1000, 10_001), RangeError);
});
