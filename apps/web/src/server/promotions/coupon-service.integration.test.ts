/**
 * Integration test — requires a real Postgres. Exercises `redeemCoupon`
 * exactly the way checkout-service.ts's `placeOrder` uses it: inside a
 * transaction, followed by a `CouponRedemption.create` using the returned
 * `couponId`. That's deliberate — a test that only called `redeemCoupon`
 * in isolation would miss the real backstop this feature depends on: the
 * `@@unique([couponId, userId])` constraint that `CouponRedemption.create`
 * hits on a race, not `redeemCoupon` itself.
 *
 * Coupon codes are created uppercase throughout, matching the real
 * invariant `createCoupon` maintains in production (see coupon-service.ts) —
 * these tests bypass that function and write directly via `prisma.coupon`,
 * so they normalize by hand instead.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createCoupon, listCoupons, redeemCoupon, setCouponActive, CouponError } from "./coupon-service.ts";

const prisma = new PrismaClient();

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function makeOrder(suffix: string, userId: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-COUPON-${suffix}`,
      userId,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PENDING_PAYMENT",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
    },
  });
  return order.id;
}

async function makeBuyer(suffix: string) {
  const user = await prisma.user.create({ data: { email: `coupon-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  return user.id;
}

/** Mirrors checkout-service.ts's placeOrder: redeem inside a transaction,
 * then create the CouponRedemption row against a real order. */
async function redeemForOrder(code: string, userId: string, subtotalSantim: number, orderId: string) {
  return prisma.$transaction(async (tx) => {
    const result = await redeemCoupon(tx, code, userId, subtotalSantim);
    await tx.couponRedemption.create({
      data: { couponId: result.couponId, userId, orderId, discountSantim: result.discountSantim },
    });
    return result;
  });
}

test("a nonexistent coupon code is rejected", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);

  await prisma.$transaction(async (tx) => {
    await assert.rejects(
      () => redeemCoupon(tx, `DOES-NOT-EXIST-${suffix}`, userId, 10_000),
      (err: unknown) => err instanceof CouponError && /doesn't exist/.test(err.message),
    );
  });
});

test("an inactive coupon is rejected", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);
  await prisma.coupon.create({
    data: { code: `INACTIVE-${suffix}`, discountType: "PERCENTAGE", discountValue: 10, active: false },
  });

  await prisma.$transaction(async (tx) => {
    await assert.rejects(
      () => redeemCoupon(tx, `INACTIVE-${suffix}`, userId, 10_000),
      (err: unknown) => err instanceof CouponError && /no longer active/.test(err.message),
    );
  });
});

test("an expired coupon is rejected", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);
  await prisma.coupon.create({
    data: {
      code: `EXPIRED-${suffix}`,
      discountType: "PERCENTAGE",
      discountValue: 10,
      validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });

  await prisma.$transaction(async (tx) => {
    await assert.rejects(
      () => redeemCoupon(tx, `EXPIRED-${suffix}`, userId, 10_000),
      (err: unknown) => err instanceof CouponError && /expired/.test(err.message),
    );
  });
});

test("a coupon not yet valid (future validFrom) is rejected", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);
  await prisma.coupon.create({
    data: {
      code: `FUTURE-${suffix}`,
      discountType: "PERCENTAGE",
      discountValue: 10,
      validFrom: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  await prisma.$transaction(async (tx) => {
    await assert.rejects(
      () => redeemCoupon(tx, `FUTURE-${suffix}`, userId, 10_000),
      (err: unknown) => err instanceof CouponError && /isn't valid yet/.test(err.message),
    );
  });
});

test("a coupon below its minimum subtotal is rejected", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);
  await prisma.coupon.create({
    data: { code: `MINSUB-${suffix}`, discountType: "FIXED_AMOUNT", discountValue: 1_000, minSubtotalSantim: 50_000 },
  });

  await prisma.$transaction(async (tx) => {
    await assert.rejects(
      () => redeemCoupon(tx, `MINSUB-${suffix}`, userId, 10_000),
      (err: unknown) => err instanceof CouponError && /at least/.test(err.message),
    );
  });
});

test("a coupon code is matched case-insensitively and trimmed", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);
  await prisma.coupon.create({
    data: { code: `MIXEDCASE-${suffix}`, discountType: "PERCENTAGE", discountValue: 10 },
  });

  const result = await prisma.$transaction((tx) =>
    redeemCoupon(tx, `  mixedcase-${suffix.toLowerCase()}  `, userId, 10_000),
  );
  assert.equal(result.discountSantim, 1_000);
});

test("PERCENTAGE and FIXED_AMOUNT discounts compute correctly, capped by maxDiscountSantim", async () => {
  const suffix = randomSuffix();
  const userId1 = await makeBuyer(`${suffix}-A`);
  const userId2 = await makeBuyer(`${suffix}-B`);

  await prisma.coupon.create({
    data: { code: `PCT-${suffix}`, discountType: "PERCENTAGE", discountValue: 50, maxDiscountSantim: 3_000 },
  });
  await prisma.coupon.create({
    data: { code: `FIXED-${suffix}`, discountType: "FIXED_AMOUNT", discountValue: 2_000 },
  });

  const pctResult = await prisma.$transaction((tx) => redeemCoupon(tx, `PCT-${suffix}`, userId1, 10_000));
  assert.equal(pctResult.discountSantim, 3_000, "50% of 10000 is 5000, but capped at 3000");

  const fixedResult = await prisma.$transaction((tx) => redeemCoupon(tx, `FIXED-${suffix}`, userId2, 10_000));
  assert.equal(fixedResult.discountSantim, 2_000);
});

test("the same customer cannot redeem the same coupon twice", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);
  const orderId1 = await makeOrder(`${suffix}-1`, userId);
  const orderId2 = await makeOrder(`${suffix}-2`, userId);
  await prisma.coupon.create({
    data: { code: `ONCE-${suffix}`, discountType: "PERCENTAGE", discountValue: 10 },
  });

  await redeemForOrder(`ONCE-${suffix}`, userId, 10_000, orderId1);

  await assert.rejects(
    () => redeemForOrder(`ONCE-${suffix}`, userId, 10_000, orderId2),
    (err: unknown) => err instanceof CouponError && /already used/.test(err.message),
  );

  const count = await prisma.couponRedemption.count({ where: { orderId: { in: [orderId1, orderId2] } } });
  assert.equal(count, 1, "only the first redemption may exist");
});

test("a coupon with a total redemption limit stops accepting once exhausted", async () => {
  const suffix = randomSuffix();
  const userId1 = await makeBuyer(`${suffix}-A`);
  const userId2 = await makeBuyer(`${suffix}-B`);
  const orderId1 = await makeOrder(`${suffix}-1`, userId1);
  const orderId2 = await makeOrder(`${suffix}-2`, userId2);
  const coupon = await prisma.coupon.create({
    data: { code: `LIMIT1-${suffix}`, discountType: "PERCENTAGE", discountValue: 10, redemptionsRemaining: 1 },
  });

  await redeemForOrder(`LIMIT1-${suffix}`, userId1, 10_000, orderId1);

  await assert.rejects(
    () => redeemForOrder(`LIMIT1-${suffix}`, userId2, 10_000, orderId2),
    (err: unknown) => err instanceof CouponError && /reached its redemption limit/.test(err.message),
  );

  const finalCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
  assert.equal(finalCoupon.redemptionsRemaining, 0, "the failed second attempt must not go negative");
});

test("two concurrent checkouts racing a coupon's last redemption: exactly one wins, never both, never zero", async () => {
  const suffix = randomSuffix();
  const userId1 = await makeBuyer(`${suffix}-A`);
  const userId2 = await makeBuyer(`${suffix}-B`);
  const orderId1 = await makeOrder(`${suffix}-1`, userId1);
  const orderId2 = await makeOrder(`${suffix}-2`, userId2);
  const coupon = await prisma.coupon.create({
    data: { code: `RACE-${suffix}`, discountType: "PERCENTAGE", discountValue: 10, redemptionsRemaining: 1 },
  });

  const results = await Promise.allSettled([
    redeemForOrder(`RACE-${suffix}`, userId1, 10_000, orderId1),
    redeemForOrder(`RACE-${suffix}`, userId2, 10_000, orderId2),
  ]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(succeeded.length, 1, "exactly one of the two concurrent redemptions must win");
  assert.equal(failed.length, 1);

  const finalCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
  assert.equal(finalCoupon.redemptionsRemaining, 0);

  const redemptionCount = await prisma.couponRedemption.count({ where: { couponId: coupon.id } });
  assert.equal(redemptionCount, 1, "the loser's transaction must have rolled back completely, including its decrement");
});

test("createCoupon parses birr fields correctly and normalizes the code to uppercase", async () => {
  const suffix = randomSuffix();
  const created = await createCoupon({
    code: `  create-${suffix.toLowerCase()}  `,
    discountType: "FIXED_AMOUNT",
    discountValueRaw: "50.00",
    maxDiscountBirr: "100.00",
    minSubtotalBirr: "25.50",
    redemptionsRemaining: 10,
  });

  assert.equal(created.code, `CREATE-${suffix}`);
  assert.equal(created.discountValue, 5_000, "50.00 ETB must become 5000 santim");
  assert.equal(created.maxDiscountSantim, 10_000);
  assert.equal(created.minSubtotalSantim, 2_550);
  assert.equal(created.redemptionsRemaining, 10);
});

test("createCoupon rejects a duplicate code", async () => {
  const suffix = randomSuffix();
  await createCoupon({ code: `DUP-${suffix}`, discountType: "PERCENTAGE", discountValueRaw: "10" });

  await assert.rejects(
    () => createCoupon({ code: `DUP-${suffix}`, discountType: "PERCENTAGE", discountValueRaw: "20" }),
    (err: unknown) => err instanceof CouponError && /already exists/.test(err.message),
  );
});

test("createCoupon rejects a percentage discount over 100", async () => {
  const suffix = randomSuffix();
  await assert.rejects(
    () => createCoupon({ code: `OVER100-${suffix}`, discountType: "PERCENTAGE", discountValueRaw: "150" }),
    (err: unknown) => err instanceof CouponError && /between 1 and 100/.test(err.message),
  );
  const found = await prisma.coupon.findUnique({ where: { code: `OVER100-${suffix}` } });
  assert.equal(found, null, "a rejected coupon must not be persisted");
});

test("createCoupon rejects a validFrom that is not before validUntil", async () => {
  const suffix = randomSuffix();
  await assert.rejects(
    () =>
      createCoupon({
        code: `BADRANGE-${suffix}`,
        discountType: "PERCENTAGE",
        discountValueRaw: "10",
        validFrom: new Date("2027-01-01"),
        validUntil: new Date("2026-01-01"),
      }),
    (err: unknown) => err instanceof CouponError && /before the end date/.test(err.message),
  );
});

test("setCouponActive toggles visibility and listCoupons reflects real redemption counts", async () => {
  const suffix = randomSuffix();
  const userId = await makeBuyer(suffix);
  const orderId = await makeOrder(suffix, userId);
  const coupon = await createCoupon({ code: `TOGGLE-${suffix}`, discountType: "PERCENTAGE", discountValueRaw: "10" });
  await redeemForOrder(`TOGGLE-${suffix}`, userId, 10_000, orderId);

  const listed = await listCoupons();
  const found = listed.find((c) => c.id === coupon.id);
  assert.ok(found);
  assert.equal(found!._count.redemptions, 1);
  assert.equal(found!.active, true);

  await setCouponActive(coupon.id, false);
  const afterToggle = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
  assert.equal(afterToggle.active, false);

  await prisma.$transaction(async (tx) => {
    await assert.rejects(
      () => redeemCoupon(tx, `TOGGLE-${suffix}`, userId, 10_000),
      (err: unknown) => err instanceof CouponError && /no longer active/.test(err.message),
    );
  });
});

test.after(async () => {
  await prisma.couponRedemption.deleteMany({ where: { order: { orderNumber: { startsWith: "SC-COUPON-" } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: "SC-COUPON-" } } });
  await prisma.coupon.deleteMany({
    where: {
      OR: [
        { code: { startsWith: "DOES-NOT-EXIST-" } },
        { code: { startsWith: "INACTIVE-" } },
        { code: { startsWith: "EXPIRED-" } },
        { code: { startsWith: "FUTURE-" } },
        { code: { startsWith: "MINSUB-" } },
        { code: { startsWith: "MIXEDCASE-" } },
        { code: { startsWith: "PCT-" } },
        { code: { startsWith: "FIXED-" } },
        { code: { startsWith: "ONCE-" } },
        { code: { startsWith: "LIMIT1-" } },
        { code: { startsWith: "RACE-" } },
        { code: { startsWith: "CREATE-" } },
        { code: { startsWith: "DUP-" } },
        { code: { startsWith: "OVER100-" } },
        { code: { startsWith: "BADRANGE-" } },
        { code: { startsWith: "TOGGLE-" } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: "coupon-buyer-" } } });
  await prisma.$disconnect();
});
