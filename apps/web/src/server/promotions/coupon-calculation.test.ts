import test from "node:test";
import assert from "node:assert/strict";
import { computeCouponDiscountSantim } from "./coupon-calculation.ts";

test("PERCENTAGE discount computes a fraction of the subtotal, rounded", () => {
  // 12345 * 10 / 100 = 1234.5 -> rounds to 1235
  const result = computeCouponDiscountSantim(12_345, {
    discountType: "PERCENTAGE",
    discountValue: 10,
    maxDiscountSantim: null,
  });
  assert.equal(result, 1_235);
});

test("FIXED_AMOUNT discount ignores the subtotal entirely, up to the cap below", () => {
  const result = computeCouponDiscountSantim(50_000, {
    discountType: "FIXED_AMOUNT",
    discountValue: 2_000,
    maxDiscountSantim: null,
  });
  assert.equal(result, 2_000);
});

test("maxDiscountSantim caps a PERCENTAGE discount", () => {
  const result = computeCouponDiscountSantim(100_000, {
    discountType: "PERCENTAGE",
    discountValue: 50, // would be 50000 uncapped
    maxDiscountSantim: 5_000,
  });
  assert.equal(result, 5_000);
});

test("maxDiscountSantim also caps a FIXED_AMOUNT discount", () => {
  const result = computeCouponDiscountSantim(100_000, {
    discountType: "FIXED_AMOUNT",
    discountValue: 20_000,
    maxDiscountSantim: 5_000,
  });
  assert.equal(result, 5_000);
});

test("a discount can never exceed the subtotal itself — no negative-total order", () => {
  const result = computeCouponDiscountSantim(1_000, {
    discountType: "FIXED_AMOUNT",
    discountValue: 999_999,
    maxDiscountSantim: null,
  });
  assert.equal(result, 1_000);
});

test("a 100% PERCENTAGE discount on a zero subtotal is zero, not NaN or negative", () => {
  const result = computeCouponDiscountSantim(0, {
    discountType: "PERCENTAGE",
    discountValue: 100,
    maxDiscountSantim: null,
  });
  assert.equal(result, 0);
  assert.ok(!Object.is(result, -0));
});

test("rejects a non-integer or negative subtotal", () => {
  const rules = { discountType: "FIXED_AMOUNT", discountValue: 100, maxDiscountSantim: null } as const;
  assert.throws(() => computeCouponDiscountSantim(10.5, rules), RangeError);
  assert.throws(() => computeCouponDiscountSantim(-100, rules), RangeError);
});

test("rejects a negative discountValue", () => {
  assert.throws(
    () =>
      computeCouponDiscountSantim(1_000, {
        discountType: "FIXED_AMOUNT",
        discountValue: -50,
        maxDiscountSantim: null,
      }),
    RangeError,
  );
});
