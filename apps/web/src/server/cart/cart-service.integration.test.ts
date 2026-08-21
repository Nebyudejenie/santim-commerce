/**
 * Integration test — requires a real Postgres. First dedicated coverage
 * for this module (confirmed absent by grep before this) — a real,
 * pre-existing gap in code directly upstream of checkout, the subsystem
 * this project's own docs already call the highest-risk one.
 *
 * The properties that matter most: `addLine` refuses anything not
 * genuinely buyable (inactive variant, unpublished product, unapproved
 * seller) using the EXACT SAME three-way check checkout later re-verifies,
 * not a looser or stricter copy of it; a repeat add increments the real
 * existing line via the real `@@unique([cartId, variantId])` constraint,
 * never creating a duplicate row; and `mergeGuestCartIntoUser` — the most
 * branch-heavy function here — correctly handles all four real cases:
 * no guest cart, claim outright, merge-with-quantity-sum into an existing
 * user cart (never dropping items either side added on purpose), and a
 * same-user re-login being a real no-op.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  addLine,
  cartSubtotalSantim,
  CartError,
  generateCartToken,
  getOrCreateCart,
  mergeGuestCartIntoUser,
  priceCartLines,
  removeLine,
  updateLineQuantity,
  VariantUnavailableError,
  type CartLineLike,
} from "./cart-service.ts";

const prisma = new PrismaClient();

// Cart tokens are random, unguessable strings — there is no shared prefix
// to clean up by. `node --test` runs integration test FILES concurrently
// by default, so a blanket "delete every cartless guest cart" cleanup
// would risk deleting a genuinely unrelated cart another file created at
// the same time. Every token this file creates is tracked here instead,
// and CartLine rows cascade-delete automatically when their real Cart
// row does (see CartLine.cart's own onDelete: Cascade) — see schema.prisma.
const createdCartTokens: string[] = [];

function trackedToken(): string {
  const token = generateCartToken();
  createdCartTokens.push(token);
  return token;
}

async function makeVariant(
  suffix: string,
  opts: { productStatus?: "ACTIVE" | "DRAFT"; sellerStatus?: "APPROVED" | "SUSPENDED"; active?: boolean } = {},
) {
  const owner = await prisma.user.create({ data: { email: `cart-test-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Cart Test Seller ${suffix}`, slug: `cart-test-seller-${suffix}`, status: opts.sellerStatus ?? "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `cart-test-${suffix}`, title: "Cart Test Item", description: "d", status: opts.productStatus ?? "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `CART-${suffix}`, title: "Default", priceSantim: 10_000, active: opts.active ?? true },
  });
  return variant.id;
}

test("addLine rejects an invalid quantity before touching the database", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix);
  const cartToken = trackedToken();

  await assert.rejects(() => addLine({ cartToken, variantId, quantity: 0 }), CartError);
  await assert.rejects(() => addLine({ cartToken, variantId, quantity: -1 }), CartError);
  await assert.rejects(() => addLine({ cartToken, variantId, quantity: 1.5 }), CartError);
});

test("addLine rejects an inactive variant, an unpublished product, and a non-approved seller's variant — the exact real gate checkout re-verifies", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const inactiveVariantId = await makeVariant(`inactive-${suffix}`, { active: false });
  const draftVariantId = await makeVariant(`draft-${suffix}`, { productStatus: "DRAFT" });
  const suspendedVariantId = await makeVariant(`suspended-${suffix}`, { sellerStatus: "SUSPENDED" });

  await assert.rejects(() => addLine({ cartToken: trackedToken(), variantId: inactiveVariantId, quantity: 1 }), VariantUnavailableError);
  await assert.rejects(() => addLine({ cartToken: trackedToken(), variantId: draftVariantId, quantity: 1 }), VariantUnavailableError);
  await assert.rejects(() => addLine({ cartToken: trackedToken(), variantId: suspendedVariantId, quantity: 1 }), VariantUnavailableError);
});

test("addLine creates a real cart and line on a first add, snapshotting the real current price", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix);
  const cartToken = trackedToken();

  const line = await addLine({ cartToken, variantId, quantity: 2 });
  assert.equal(line.quantity, 2);
  assert.equal(line.unitPriceSantim, 10_000);

  const cart = await prisma.cart.findUniqueOrThrow({ where: { token: cartToken }, include: { lines: true } });
  assert.equal(cart.lines.length, 1);
});

test("adding the same variant twice increments the real existing line, never a duplicate row", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix);
  const cartToken = trackedToken();

  await addLine({ cartToken, variantId, quantity: 2 });
  await addLine({ cartToken, variantId, quantity: 3 });

  const cart = await prisma.cart.findUniqueOrThrow({ where: { token: cartToken }, include: { lines: true } });
  assert.equal(cart.lines.length, 1, "must still be exactly one line for this variant");
  assert.equal(cart.lines[0]!.quantity, 5, "quantities must add, not overwrite");
});

test("a returning guest (same token) reuses their real existing cart rather than creating a second one", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantA = await makeVariant(`a-${suffix}`);
  const variantB = await makeVariant(`b-${suffix}`);
  const cartToken = trackedToken();

  await addLine({ cartToken, variantId: variantA, quantity: 1 });
  await addLine({ cartToken, variantId: variantB, quantity: 1 });

  const carts = await prisma.cart.findMany({ where: { token: cartToken } });
  assert.equal(carts.length, 1);
  const cart = await getOrCreateCart(cartToken, null);
  assert.equal(cart.lines.length, 2);
});

test("updateLineQuantity sets a real new quantity, and a non-positive quantity removes the real line", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix);
  const cartToken = trackedToken();
  await addLine({ cartToken, variantId, quantity: 2 });

  await updateLineQuantity(cartToken, variantId, 5);
  const afterUpdate = await prisma.cart.findUniqueOrThrow({ where: { token: cartToken }, include: { lines: true } });
  assert.equal(afterUpdate.lines[0]!.quantity, 5);

  await updateLineQuantity(cartToken, variantId, 0);
  const afterRemoval = await prisma.cart.findUniqueOrThrow({ where: { token: cartToken }, include: { lines: true } });
  assert.equal(afterRemoval.lines.length, 0, "a quantity of 0 must remove the line, not set it to 0");
});

test("updateLineQuantity on a nonexistent cart token is rejected, not a silent no-op", async () => {
  await assert.rejects(() => updateLineQuantity("nonexistent-token-xyz", "some-variant-id", 1), CartError);
});

test("removeLine deletes a real line, and is a real no-op (never throws) for a nonexistent cart", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const variantId = await makeVariant(suffix);
  const cartToken = trackedToken();
  await addLine({ cartToken, variantId, quantity: 1 });

  await removeLine(cartToken, variantId);
  const cart = await prisma.cart.findUniqueOrThrow({ where: { token: cartToken }, include: { lines: true } });
  assert.equal(cart.lines.length, 0);

  // Must not throw for a cart that was never real.
  await removeLine("nonexistent-token-xyz", variantId);
});

test("mergeGuestCartIntoUser with no guest token at all creates a real fresh cart for the user", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({ data: { email: `cart-test-user-${suffix}@example.et`, role: "CUSTOMER" } });

  const token = await mergeGuestCartIntoUser(undefined, user.id);
  const cart = await prisma.cart.findUniqueOrThrow({ where: { token } });
  assert.equal(cart.userId, user.id);
});

test("mergeGuestCartIntoUser claims a real guest cart outright when the user has no existing cart yet", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({ data: { email: `cart-test-user-${suffix}@example.et`, role: "CUSTOMER" } });
  const variantId = await makeVariant(suffix);
  const guestToken = trackedToken();
  await addLine({ cartToken: guestToken, variantId, quantity: 1 });

  const resultToken = await mergeGuestCartIntoUser(guestToken, user.id);
  assert.equal(resultToken, guestToken, "the SAME cart is claimed, not replaced");

  const cart = await prisma.cart.findUniqueOrThrow({ where: { token: guestToken }, include: { lines: true } });
  assert.equal(cart.userId, user.id);
  assert.equal(cart.lines.length, 1, "the real items the guest added must survive the claim");
});

test("mergeGuestCartIntoUser merges BOTH real carts with quantities summed, and marks the guest cart ABANDONED, never deleted", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({ data: { email: `cart-test-user-${suffix}@example.et`, role: "CUSTOMER" } });
  const sharedVariantId = await makeVariant(`shared-${suffix}`);
  const guestOnlyVariantId = await makeVariant(`guestonly-${suffix}`);

  // The user's own persistent cart, from a previous session.
  const userToken = trackedToken();
  await addLine({ cartToken: userToken, variantId: sharedVariantId, quantity: 1 });
  await prisma.cart.update({ where: { token: userToken }, data: { userId: user.id } });

  // A NEW guest cart from this session, overlapping on one variant.
  const guestToken = trackedToken();
  await addLine({ cartToken: guestToken, variantId: sharedVariantId, quantity: 2 });
  await addLine({ cartToken: guestToken, variantId: guestOnlyVariantId, quantity: 1 });

  const resultToken = await mergeGuestCartIntoUser(guestToken, user.id);
  assert.equal(resultToken, userToken, "the persistent user cart is what survives, not the guest one");

  const mergedCart = await prisma.cart.findUniqueOrThrow({ where: { token: userToken }, include: { lines: true } });
  const sharedLine = mergedCart.lines.find((l) => l.variantId === sharedVariantId);
  const guestOnlyLine = mergedCart.lines.find((l) => l.variantId === guestOnlyVariantId);
  assert.equal(sharedLine?.quantity, 3, "1 (user's) + 2 (guest's) — quantities must sum, never overwrite");
  assert.equal(guestOnlyLine?.quantity, 1, "an item only the guest added must survive the merge too");

  const abandonedGuestCart = await prisma.cart.findUniqueOrThrow({ where: { token: guestToken } });
  assert.equal(abandonedGuestCart.status, "ABANDONED", "the guest cart must be marked abandoned, never hard-deleted");
});

test("mergeGuestCartIntoUser is a real no-op when the guest token already belongs to this same user", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({ data: { email: `cart-test-user-${suffix}@example.et`, role: "CUSTOMER" } });
  const variantId = await makeVariant(suffix);
  const token = trackedToken();
  await addLine({ cartToken: token, variantId, quantity: 1 });
  await prisma.cart.update({ where: { token }, data: { userId: user.id } });

  const resultToken = await mergeGuestCartIntoUser(token, user.id);
  assert.equal(resultToken, token);

  const cart = await prisma.cart.findUniqueOrThrow({ where: { token }, include: { lines: true } });
  assert.equal(cart.lines.length, 1, "re-merging their own cart must not duplicate anything");
  assert.equal(cart.status, "ACTIVE", "must not have been marked abandoned — it's still their real active cart");
});

test("priceCartLines detects a real price change since add-time, and cartSubtotalSantim sums the real current totals", () => {
  const lines: CartLineLike[] = [
    {
      variantId: "v1",
      quantity: 2,
      unitPriceSantim: 10_000, // snapshotted at add-time
      variant: { priceSantim: 12_000, active: true, product: { status: "ACTIVE" } }, // price rose since
    },
    {
      variantId: "v2",
      quantity: 1,
      unitPriceSantim: 5_000,
      variant: { priceSantim: 5_000, active: true, product: { status: "ACTIVE" } }, // unchanged
    },
  ];

  const priced = priceCartLines(lines);
  assert.equal(priced[0]!.priceChanged, true);
  assert.equal(priced[0]!.currentPriceSantim, 12_000);
  assert.equal(priced[0]!.lineTotalSantim, 24_000, "line total must use the CURRENT price, not the stale snapshot");
  assert.equal(priced[1]!.priceChanged, false);

  assert.equal(cartSubtotalSantim(priced), 29_000, "24000 + 5000");
});

test.after(async () => {
  // Real carts this file created, by their own tracked tokens — see
  // createdCartTokens's own comment on why a blanket "delete every
  // cartless guest cart" would be unsafe under concurrent test files.
  // CartLine rows cascade-delete with their real Cart row.
  await prisma.cart.deleteMany({ where: { token: { in: createdCartTokens } } });
  // Any real cart this file gave a userId to (merge/claim tests) —
  // scoped to this file's own user-email prefix, so still safe under
  // concurrent files.
  await prisma.cart.deleteMany({ where: { user: { email: { startsWith: "cart-test-user-" } } } });
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "cart-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "cart-test-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "cart-test-seller-" } } });
  await prisma.user.deleteMany({
    where: { OR: [{ email: { startsWith: "cart-test-seller-" } }, { email: { startsWith: "cart-test-user-" } }] },
  });
  await prisma.$disconnect();
});
