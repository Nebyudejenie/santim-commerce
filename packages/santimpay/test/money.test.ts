import test from "node:test";
import assert from "node:assert/strict";
import {
  allocate, applyRate, birr, format, fromGatewayAmount, MoneyError,
  multiply, parseBirr, santim, sum, toGatewayAmount,
} from "../src/money.js";

test("birr() converts major units to integer santim", () => {
  assert.equal(birr(1), 100);
  assert.equal(birr(19.99), 1999);
  assert.equal(birr(0.05), 5);
  assert.equal(birr(0), 0);
});

test("birr() survives IEEE-754 representation error", () => {
  // 19.99 * 100 === 1998.9999999999998 in floating point. Naive Math.trunc
  // would yield 1998 and lose a santim on every such price.
  assert.equal(birr(19.99), 1999);
  assert.equal(birr(1.15), 115);
  assert.equal(birr(1234.56), 123456);
});

test("birr() rejects sub-santim precision instead of silently rounding", () => {
  assert.throws(() => birr(1.005), MoneyError);
  assert.throws(() => birr(0.001), MoneyError);
});

test("santim() rejects non-integers", () => {
  assert.throws(() => santim(1.5), MoneyError);
});

test("parseBirr() handles decimal strings exactly", () => {
  assert.equal(parseBirr("1234.50"), 123450);
  assert.equal(parseBirr("0.01"), 1);
  assert.equal(parseBirr("100"), 10000);
  assert.equal(parseBirr("7.5"), 750);
  assert.equal(parseBirr("-3.25"), -325);
  assert.throws(() => parseBirr("1.234"), MoneyError);
  assert.throws(() => parseBirr("abc"), MoneyError);
});

test("summing a cart does not drift", () => {
  // The classic float failure: 0.1 + 0.2 !== 0.3
  const lines = [birr(0.1), birr(0.2)];
  assert.equal(sum(lines), 30);
  assert.equal(toGatewayAmount(sum(lines)), 0.3);

  // 1000 items at 19.99 must be exactly 19990.00
  const many = Array.from({ length: 1000 }, () => birr(19.99));
  assert.equal(sum(many), 1_999_000);
  assert.equal(toGatewayAmount(sum(many)), 19990);
});

test("multiply() requires whole quantities", () => {
  assert.equal(multiply(birr(19.99), 3), 5997);
  assert.throws(() => multiply(birr(1), -1), MoneyError);
  assert.throws(() => multiply(birr(1), 1.5), MoneyError);
});

test("allocate() distributes without losing a santim", () => {
  const parts = allocate(santim(100), 3);
  assert.deepEqual(parts, [34, 33, 33]);
  assert.equal(sum(parts), 100);

  const tricky = allocate(santim(1001), 7);
  assert.equal(sum(tricky), 1001);
});

test("applyRate() rounds explicitly", () => {
  assert.equal(applyRate(santim(1000), 0.15), 150);
  assert.equal(applyRate(santim(333), 0.15, "half-up"), 50); // 49.95
  assert.equal(applyRate(santim(333), 0.15, "down"), 49);
  assert.equal(applyRate(santim(333), 0.15, "up"), 50);
});

test("gateway amount round-trips", () => {
  for (const value of [1, 19.99, 0.05, 1234.56, 100000]) {
    assert.equal(fromGatewayAmount(toGatewayAmount(birr(value))), birr(value));
  }
  assert.equal(fromGatewayAmount("0.5"), 50);
  assert.equal(fromGatewayAmount("1"), 100);
});

test("format() renders ETB", () => {
  assert.match(format(santim(123450)), /1,234\.50/);
});
