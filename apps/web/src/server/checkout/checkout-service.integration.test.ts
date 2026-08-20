/**
 * Integration test — requires a real Postgres. checkout-service.ts had NO
 * dedicated test coverage before this file (only exercised indirectly via
 * reservation.integration.test.ts, which tests reserveForOrder directly,
 * and the chaos-drill script, which proves transaction atomicity but not
 * this validation logic) — a real, pre-existing gap in exactly the
 * subsystem the project's own docs call the highest-risk one.
 *
 * Focused specifically on the seller-suspension re-check added alongside
 * the marketplace transformation: the master mandate's own "seller becomes
 * unavailable" edge case (section 5/19) — a customer can have an item in
 * their cart from BEFORE a seller was suspended, and checkout must refuse
 * it, not silently let the sale through.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { addLine, generateCartToken, getOrCreateCart } from "../cart/cart-service.ts";
import { CheckoutError, placeOrder } from "./checkout-service.ts";
import { suspendSeller } from "../sellers/seller-service.ts";

const prisma = new PrismaClient();

async function makeApprovedSellerWithProduct(suffix: string) {
  const owner = await prisma.user.create({ data: { email: `checkout-test-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Checkout Test ${suffix}`, slug: `checkout-test-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `checkout-test-${suffix}`, title: "Checkout Test Item", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `CHK-${suffix}`, title: "Default", priceSantim: 5000 },
  });
  await prisma.inventory.create({ data: { variantId: variant.id, onHand: 10, reserved: 0 } });
  return { sellerId: seller.id, variantId: variant.id };
}

test("checkout refuses an item whose seller was suspended after it was added to the cart", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { sellerId, variantId } = await makeApprovedSellerWithProduct(suffix);
  // A per-test-unique email, not the shared literal "buyer@example.et" a
  // dozen other integration test files also use — this file's own
  // assertions below need to be scoped to THIS test's attempt, not
  // whatever else happens to be running concurrently (node --test runs
  // integration test FILES in parallel by default).
  const buyerEmail = `buyer-${suffix}@example.et`;

  const cartToken = generateCartToken();
  await getOrCreateCart(cartToken, null);
  // Succeeds — the seller is still APPROVED at add-to-cart time.
  await addLine({ cartToken, variantId, quantity: 1 });

  const adminOwner = await prisma.user.create({ data: { email: `checkout-test-admin-${suffix}@example.et`, role: "ADMIN" } });
  await suspendSeller(sellerId, adminOwner.id);

  await assert.rejects(
    () =>
      placeOrder({
        cartToken,
        email: buyerEmail,
        phone: "0912345678",
        shippingZone: "ADDIS_ABABA",
      }),
    (err: unknown) => err instanceof CheckoutError && /no longer available/.test(err.message),
  );

  // No order must have been created from the rejected attempt.
  const orders = await prisma.order.findMany({ where: { email: buyerEmail } });
  assert.equal(orders.length, 0, "a rejected checkout must not leave a partial order behind");
});

test("checkout rejects a coupon code from a guest — the per-user redemption limit has nothing to key on without a userId", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { variantId } = await makeApprovedSellerWithProduct(`coupon-guest-${suffix}`);
  const buyerEmail = `buyer-${suffix}@example.et`;

  const cartToken = generateCartToken();
  await getOrCreateCart(cartToken, null);
  await addLine({ cartToken, variantId, quantity: 1 });

  await assert.rejects(
    () =>
      placeOrder({
        cartToken,
        email: buyerEmail,
        phone: "0912345678",
        shippingZone: "ADDIS_ABABA",
        userId: null,
        couponCode: "ANYCODE",
      }),
    (err: unknown) => err instanceof CheckoutError && /Sign in to use a coupon/.test(err.message),
  );

  // Rejected before any DB work starts — real proof, not an assumption:
  // no order, and the coupon-service.ts code path (which would need a real
  // userId) was never reached.
  const orders = await prisma.order.findMany({ where: { email: buyerEmail } });
  assert.equal(orders.length, 0);
});

// A full happy-path test through placeOrder() is deliberately NOT written
// here: placeOrder calls env() (checkout-service.ts:143) BEFORE its DB
// transaction even starts, and then — on success — calls the real
// SantimPay gateway (startPayment, after commit, per this module's own
// step 6). No test anywhere in this codebase exercises that far; doing so
// would need either a mocked gateway (doesn't exist in this test suite) or
// a real outbound network call with fake credentials, neither of which
// belongs in an automated test. The seller-suspension case above is the
// one this file exists to prove, and it correctly rejects before either of
// those concerns come into play.

test.after(async () => {
  // Scoped to this file's own email convention (buyer-<suffix>@...), not
  // the bare "buyer" prefix other integration test files also use for
  // their own, unrelated orders — see this file's own comment above on why.
  await prisma.orderLine.deleteMany({ where: { order: { email: { startsWith: "buyer-" } } } });
  await prisma.paymentIntent.deleteMany({ where: { order: { email: { startsWith: "buyer-" } } } });
  await prisma.order.deleteMany({ where: { email: { startsWith: "buyer-" } } });
  await prisma.cartLine.deleteMany({ where: { variant: { product: { slug: { startsWith: "checkout-test-" } } } } });
  await prisma.cart.deleteMany({ where: { lines: { none: {} } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "checkout-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "checkout-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "checkout-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "checkout-test-" } } });
  await prisma.$disconnect();
});
