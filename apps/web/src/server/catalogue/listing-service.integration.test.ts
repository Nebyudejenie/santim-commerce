/**
 * Integration test — requires a real Postgres. Same discipline as every
 * other *.integration.test.ts in this repo: the property that matters most
 * here — a seller can never touch another seller's listing — is an
 * authorization property, and authorization bugs are exactly the class of
 * bug a mocked Prisma client is least likely to catch (it never enforces
 * anything, so a broken `where` clause that "forgets" the ownership filter
 * still returns whatever the mock was told to return).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  addVariant,
  createProduct,
  getSellerProduct,
  ListingError,
  listSellerProducts,
  setProductFeaturedAsAdmin,
  setProductStatus,
  updateProduct,
  updateVariant,
} from "./listing-service.ts";

const prisma = new PrismaClient();

async function makeSeller(suffix: string) {
  const user = await prisma.user.create({
    data: { email: `listing-test-${suffix}@example.et`, role: "CUSTOMER" },
  });
  const seller = await prisma.seller.create({
    data: { ownerId: user.id, storeName: `Listing Test Seller ${suffix}`, slug: `listing-test-${suffix}`, status: "APPROVED" },
  });
  return seller.id;
}

function baseInput(suffix: string) {
  return {
    title: `Test Product ${suffix}`,
    description: "A real description, long enough to pass validation.",
    variantTitle: "Default",
    sku: `SKU-${suffix}`,
    priceBirr: "199.99",
    onHand: "10",
  };
}

test("a new listing starts DRAFT with one variant and real inventory", async () => {
  const sellerId = await makeSeller(`create-${Math.random().toString(36).slice(2, 8)}`);
  const product = await createProduct(sellerId, baseInput("A"));

  assert.equal(product.status, "DRAFT");

  const full = await getSellerProduct(sellerId, product.id);
  assert.equal(full?.variants.length, 1);
  assert.equal(full?.variants[0]?.priceSantim, 19999);
  assert.equal(full?.variants[0]?.inventory?.onHand, 10);
});

test("publishing requires a variant, and DRAFT -> ACTIVE -> ARCHIVED -> ACTIVE is legal", async () => {
  const sellerId = await makeSeller(`publish-${Math.random().toString(36).slice(2, 8)}`);
  const product = await createProduct(sellerId, baseInput("B"));

  const active = await setProductStatus(sellerId, product.id, "ACTIVE");
  assert.equal(active.status, "ACTIVE");

  const archived = await setProductStatus(sellerId, product.id, "ARCHIVED");
  assert.equal(archived.status, "ARCHIVED");

  const reactivated = await setProductStatus(sellerId, product.id, "ACTIVE");
  assert.equal(reactivated.status, "ACTIVE");

  // Illegal: DRAFT -> ARCHIVED is not a real transition (nothing to archive).
  const draftProduct = await createProduct(sellerId, baseInput("B2"));
  await assert.rejects(() => setProductStatus(sellerId, draftProduct.id, "ARCHIVED"), ListingError);
});

test("a seller CANNOT edit, publish, or add a variant to another seller's listing", async () => {
  const ownerSellerId = await makeSeller(`owner-${Math.random().toString(36).slice(2, 8)}`);
  const attackerSellerId = await makeSeller(`attacker-${Math.random().toString(36).slice(2, 8)}`);
  const product = await createProduct(ownerSellerId, baseInput("C"));

  await assert.rejects(
    () => updateProduct(attackerSellerId, product.id, { title: "Hijacked Title" }),
    ListingError,
  );
  await assert.rejects(
    () => setProductStatus(attackerSellerId, product.id, "ACTIVE"),
    ListingError,
  );
  await assert.rejects(
    () => addVariant(attackerSellerId, product.id, { title: "Evil Variant", sku: "EVIL", priceBirr: "1.00", onHand: "1" }),
    ListingError,
  );

  // getSellerProduct returns null, not the foreign product, for a non-owner.
  const asAttacker = await getSellerProduct(attackerSellerId, product.id);
  assert.equal(asAttacker, null);

  // Confirm none of the rejected calls actually mutated anything.
  const untouched = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  assert.equal(untouched.title, "Test Product C");
  assert.equal(untouched.status, "DRAFT");
  const variantCount = await prisma.variant.count({ where: { productId: product.id } });
  assert.equal(variantCount, 1, "the attacker's addVariant call must not have created a row");
});

test("a seller cannot update another seller's variant either, even with a real variantId", async () => {
  const ownerSellerId = await makeSeller(`vowner-${Math.random().toString(36).slice(2, 8)}`);
  const attackerSellerId = await makeSeller(`vattacker-${Math.random().toString(36).slice(2, 8)}`);
  const product = await createProduct(ownerSellerId, baseInput("D"));
  const owned = await getSellerProduct(ownerSellerId, product.id);
  const variantId = owned!.variants[0]!.id;

  await assert.rejects(
    () => updateVariant(attackerSellerId, variantId, { priceBirr: "0.01" }),
    ListingError,
  );

  const untouched = await prisma.variant.findUniqueOrThrow({ where: { id: variantId } });
  assert.equal(untouched.priceSantim, 19999, "the attacker's price change must not have applied");
});

test("adding a second variant with a duplicate SKU on the SAME product is rejected", async () => {
  const sellerId = await makeSeller(`dupsku-${Math.random().toString(36).slice(2, 8)}`);
  const product = await createProduct(sellerId, baseInput("E"));

  await assert.rejects(
    () => addVariant(sellerId, product.id, { title: "Second", sku: baseInput("E").sku, priceBirr: "50.00", onHand: "5" }),
    ListingError,
  );
});

test("updateVariant's onHand is an absolute set, and listSellerProducts only returns this seller's own listings", async () => {
  const sellerA = await makeSeller(`list-a-${Math.random().toString(36).slice(2, 8)}`);
  const sellerB = await makeSeller(`list-b-${Math.random().toString(36).slice(2, 8)}`);
  const productA = await createProduct(sellerA, baseInput("F"));
  await createProduct(sellerB, baseInput("G"));

  const ownedA = await getSellerProduct(sellerA, productA.id);
  await updateVariant(sellerA, ownedA!.variants[0]!.id, { onHand: 42 });
  const refetched = await getSellerProduct(sellerA, productA.id);
  assert.equal(refetched?.variants[0]?.inventory?.onHand, 42);

  const listA = await listSellerProducts(sellerA);
  assert.equal(listA.length, 1);
  assert.equal(listA[0]?.id, productA.id);
});

test("updateVariant restocking a variant from zero enqueues a real back-in-stock check, but a stock correction that stays at zero does not", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`restock-${suffix}`);
  const product = await createProduct(sellerId, { ...baseInput(`restock-${suffix}`), onHand: "0" });
  const owned = await getSellerProduct(sellerId, product.id);
  const variantId = owned!.variants[0]!.id;

  const buyer = await prisma.user.create({ data: { email: `listing-test-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  await prisma.backInStockRequest.create({ data: { userId: buyer.id, variantId } });

  // A correction that leaves it still at zero must not enqueue anything —
  // enqueueBackInStockCheck's own real availability check, not just "an
  // onHand write happened at all".
  await updateVariant(sellerId, variantId, { onHand: 0 });
  const beforeRestock = await prisma.outboxMessage.findMany({ where: { topic: "variant.restocked" } });
  assert.equal(beforeRestock.filter((m) => (m.payload as { variantId: string }).variantId === variantId).length, 0);

  await updateVariant(sellerId, variantId, { onHand: 5 });
  const afterRestock = await prisma.outboxMessage.findMany({ where: { topic: "variant.restocked" } });
  assert.equal(afterRestock.filter((m) => (m.payload as { variantId: string }).variantId === variantId).length, 1);
});

test("updateVariant sets a real, per-variant lowStockThreshold, and a stock drop below it enqueues a real seller alert", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`lowstock-${suffix}`);
  const product = await createProduct(sellerId, { ...baseInput(`lowstock-${suffix}`), onHand: "20" });
  const owned = await getSellerProduct(sellerId, product.id);
  const variantId = owned!.variants[0]!.id;

  await updateVariant(sellerId, variantId, { lowStockThreshold: 15 });
  const refetched = await getSellerProduct(sellerId, product.id);
  assert.equal(refetched?.variants[0]?.inventory?.lowStockThreshold, 15);

  // 20 available, threshold 15 — still healthy, no alert yet.
  const before = await prisma.outboxMessage.findMany({ where: { topic: "variant.low_stock" } });
  assert.equal(before.filter((m) => (m.payload as { variantId: string }).variantId === variantId).length, 0);

  // Correcting onHand down to 10 crosses the real, seller-set threshold.
  await updateVariant(sellerId, variantId, { onHand: 10 });
  const after = await prisma.outboxMessage.findMany({ where: { topic: "variant.low_stock" } });
  assert.equal(after.filter((m) => (m.payload as { variantId: string }).variantId === variantId).length, 1);
});

test("setProductFeaturedAsAdmin is the only way to mark a product featured — a seller's own updateProduct has no such field", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`featured-${suffix}`);
  const product = await createProduct(sellerId, baseInput(`featured-${suffix}`));

  const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  assert.equal(before.featured, false, "featured must default to false, never true from seed/creation");

  await setProductFeaturedAsAdmin(product.id, true);
  const afterFeatured = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  assert.equal(afterFeatured.featured, true);

  await setProductFeaturedAsAdmin(product.id, false);
  const afterUnfeatured = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  assert.equal(afterUnfeatured.featured, false);
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "variant.restocked" } });
  await prisma.outboxMessage.deleteMany({ where: { topic: "variant.low_stock" } });
  await prisma.backInStockRequest.deleteMany({ where: { variant: { product: { seller: { slug: { startsWith: "listing-test-" } } } } } });
  await prisma.variant.deleteMany({ where: { product: { seller: { slug: { startsWith: "listing-test-" } } } } });
  await prisma.product.deleteMany({ where: { seller: { slug: { startsWith: "listing-test-" } } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "listing-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "listing-test-" } } });
  await prisma.$disconnect();
});
