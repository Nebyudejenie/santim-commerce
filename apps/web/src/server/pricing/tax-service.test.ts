import test from "node:test";
import assert from "node:assert/strict";
import { calculateTax, ETHIOPIA_VAT_RATE } from "./tax-service.ts";
import { santim } from "@santim/santimpay/money";

test("VAT rate is 15%", () => {
  assert.equal(ETHIOPIA_VAT_RATE, 0.15);
});

test("calculates 15% VAT on a round subtotal", () => {
  assert.equal(calculateTax(santim(100_000)), 15_000); // ETB 1,000.00 -> ETB 150.00
});

test("rounds half-up, matching the money module's documented convention", () => {
  // 333 * 0.15 = 49.95 -> rounds to 50
  assert.equal(calculateTax(santim(333)), 50);
});

test("zero subtotal produces zero tax", () => {
  assert.equal(calculateTax(santim(0)), 0);
});

test("VAT on a realistic cart total", () => {
  // Aria Overshirt (ETB 3,450.00) + Essential Tee (ETB 950.00) = ETB 4,400.00
  const subtotal = santim(345_000 + 95_000);
  assert.equal(calculateTax(subtotal), 66_000); // ETB 660.00
});
