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

test("createProduct sets real options on the first variant when given, and leaves it {} when not — the storefront's own variant-selector data", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`options-${suffix}`);

  const withOptions = await createProduct(sellerId, { ...baseInput(`options-a-${suffix}`), optionName: "Size", optionValue: "M" });
  const fullWithOptions = await getSellerProduct(sellerId, withOptions.id);
  assert.deepEqual(fullWithOptions?.variants[0]?.options, { Size: "M" });

  const withoutOptions = await createProduct(sellerId, baseInput(`options-b-${suffix}`));
  const fullWithoutOptions = await getSellerProduct(sellerId, withoutOptions.id);
  assert.deepEqual(fullWithoutOptions?.variants[0]?.options, {});
});

test("addVariant sets real options on a real new variant", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`addopt-${suffix}`);
  const product = await createProduct(sellerId, { ...baseInput(`addopt-${suffix}`), optionName: "Size", optionValue: "S" });

  await addVariant(sellerId, product.id, {
    title: "Size M",
    sku: `ADDOPT-${suffix}-M`,
    priceBirr: "199.99",
    onHand: "5",
    optionName: "Size",
    optionValue: "M",
  });

  const full = await getSellerProduct(sellerId, product.id);
  const added = full?.variants.find((v) => v.sku === `ADDOPT-${suffix}-M`);
  assert.deepEqual(added?.options, { Size: "M" });
});

test("updateVariant sets, then clears, real options — the same 'blank clears it' convention as compareAtBirr", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`updopt-${suffix}`);
  const product = await createProduct(sellerId, baseInput(`updopt-${suffix}`));
  const owned = await getSellerProduct(sellerId, product.id);
  const variantId = owned!.variants[0]!.id;

  await updateVariant(sellerId, variantId, { optionName: "Colour", optionValue: "Black" });
  const withOption = await getSellerProduct(sellerId, product.id);
  assert.deepEqual(withOption?.variants[0]?.options, { Colour: "Black" });

  await updateVariant(sellerId, variantId, { optionName: "", optionValue: "" });
  const cleared = await getSellerProduct(sellerId, product.id);
  assert.deepEqual(cleared?.variants[0]?.options, {}, "a blank name/value must clear the real options, not leave the old ones");
});

test("allowBackorder is real, writable state — set on createProduct, addVariant, and updateVariant, defaulting to false", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`backorder-${suffix}`);

  const withBackorder = await createProduct(sellerId, { ...baseInput(`backorder-a-${suffix}`), allowBackorder: true });
  const fullWithBackorder = await getSellerProduct(sellerId, withBackorder.id);
  assert.equal(fullWithBackorder?.variants[0]?.inventory?.allowBackorder, true);

  const withoutBackorder = await createProduct(sellerId, baseInput(`backorder-b-${suffix}`));
  const fullWithoutBackorder = await getSellerProduct(sellerId, withoutBackorder.id);
  assert.equal(fullWithoutBackorder?.variants[0]?.inventory?.allowBackorder, false, "must default to false, never opt a seller in silently");

  await addVariant(sellerId, withoutBackorder.id, {
    title: "Second",
    sku: `BACKORDER-${suffix}-2`,
    priceBirr: "50.00",
    onHand: "0",
    allowBackorder: true,
  });
  const withAddedVariant = await getSellerProduct(sellerId, withoutBackorder.id);
  const added = withAddedVariant?.variants.find((v) => v.sku === `BACKORDER-${suffix}-2`);
  assert.equal(added?.inventory?.allowBackorder, true);

  const firstVariantId = fullWithoutBackorder!.variants[0]!.id;
  await updateVariant(sellerId, firstVariantId, { allowBackorder: true });
  const afterUpdate = await getSellerProduct(sellerId, withoutBackorder.id);
  assert.equal(afterUpdate?.variants.find((v) => v.id === firstVariantId)?.inventory?.allowBackorder, true);

  // And back off — a checkbox that could only ever turn ON would be its own real bug.
  await updateVariant(sellerId, firstVariantId, { allowBackorder: false });
  const afterTurningOff = await getSellerProduct(sellerId, withoutBackorder.id);
  assert.equal(afterTurningOff?.variants.find((v) => v.id === firstVariantId)?.inventory?.allowBackorder, false);
});

test("costSantim is real, writable state — set on createProduct, addVariant, and updateVariant, and clearable back to null", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`cost-${suffix}`);

  const withCost = await createProduct(sellerId, { ...baseInput(`cost-a-${suffix}`), costBirr: "120.00" });
  const fullWithCost = await getSellerProduct(sellerId, withCost.id);
  assert.equal(fullWithCost?.variants[0]?.costSantim, 12_000);

  const withoutCost = await createProduct(sellerId, baseInput(`cost-b-${suffix}`));
  const fullWithoutCost = await getSellerProduct(sellerId, withoutCost.id);
  assert.equal(fullWithoutCost?.variants[0]?.costSantim, null, "cost must default to unset, never a fabricated 0");

  await addVariant(sellerId, withoutCost.id, {
    title: "Second",
    sku: `COST-${suffix}-2`,
    priceBirr: "50.00",
    onHand: "0",
    costBirr: "30.00",
  });
  const withAddedVariant = await getSellerProduct(sellerId, withoutCost.id);
  const added = withAddedVariant?.variants.find((v) => v.sku === `COST-${suffix}-2`);
  assert.equal(added?.costSantim, 3_000);

  const firstVariantId = fullWithoutCost!.variants[0]!.id;
  await updateVariant(sellerId, firstVariantId, { costBirr: "40.00" });
  const afterUpdate = await getSellerProduct(sellerId, withoutCost.id);
  assert.equal(afterUpdate?.variants.find((v) => v.id === firstVariantId)?.costSantim, 4_000);

  // Blank clears it back to null — same convention as compareAtBirr/options.
  await updateVariant(sellerId, firstVariantId, { costBirr: "" });
  const afterClear = await getSellerProduct(sellerId, withoutCost.id);
  assert.equal(afterClear?.variants.find((v) => v.id === firstVariantId)?.costSantim, null);
});

test("addVariant/updateVariant accept a cost higher than the price — selling below cost is a real, legitimate seller choice", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`costloss-${suffix}`);
  const product = await createProduct(sellerId, baseInput(`costloss-${suffix}`));
  const owned = await getSellerProduct(sellerId, product.id);
  const variantId = owned!.variants[0]!.id;

  // baseInput's price is 199.99 — a cost above that must not be rejected.
  await updateVariant(sellerId, variantId, { costBirr: "999.00" });
  const updated = await getSellerProduct(sellerId, product.id);
  assert.equal(updated?.variants[0]?.costSantim, 99_900);
});

test("updateVariant's active flag toggles both ways — the real fix is in the FORM layer (an unchecked checkbox now genuinely submits false, see updateVariantAction), but this is the DB-level behavior that fix depends on", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`activetoggle-${suffix}`);
  const product = await createProduct(sellerId, baseInput(`activetoggle-${suffix}`));
  const owned = await getSellerProduct(sellerId, product.id);
  const variantId = owned!.variants[0]!.id;
  assert.equal(owned!.variants[0]!.active, true, "a new variant starts active");

  await updateVariant(sellerId, variantId, { active: false });
  const deactivated = await getSellerProduct(sellerId, product.id);
  assert.equal(deactivated?.variants[0]?.active, false);

  await updateVariant(sellerId, variantId, { active: true });
  const reactivated = await getSellerProduct(sellerId, product.id);
  assert.equal(reactivated?.variants[0]?.active, true);
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

test("addVariant accepts a real compareAtBirr higher than the price, and rejects one that isn't", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`compareat-add-${suffix}`);
  const product = await createProduct(sellerId, baseInput(`compareat-add-${suffix}`));

  const variant = await addVariant(sellerId, product.id, {
    title: "On Sale",
    sku: `CMP-${suffix}`,
    priceBirr: "80.00",
    onHand: "5",
    compareAtBirr: "120.00",
  });
  assert.equal(variant.compareAtSantim, 12_000);

  await assert.rejects(
    () =>
      addVariant(sellerId, product.id, {
        title: "Backwards",
        sku: `CMP2-${suffix}`,
        priceBirr: "80.00",
        onHand: "5",
        compareAtBirr: "50.00", // lower than the real price — backwards, must be rejected
      }),
    (err: unknown) => err instanceof ListingError && /higher than the actual price/.test(err.message),
  );
});

test("updateVariant sets, then clears, a real compareAtSantim — and validates against whichever price is in effect after the same update", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`compareat-upd-${suffix}`);
  const product = await createProduct(sellerId, { ...baseInput(`compareat-upd-${suffix}`), priceBirr: "100.00" });
  const owned = await getSellerProduct(sellerId, product.id);
  const variantId = owned!.variants[0]!.id;

  await updateVariant(sellerId, variantId, { compareAtBirr: "150.00" });
  let refetched = await getSellerProduct(sellerId, product.id);
  assert.equal(refetched?.variants[0]?.compareAtSantim, 15_000);

  // A blank string clears it back to null, not a no-op.
  await updateVariant(sellerId, variantId, { compareAtBirr: "" });
  refetched = await getSellerProduct(sellerId, product.id);
  assert.equal(refetched?.variants[0]?.compareAtSantim, null);

  // A compare-at that's only invalid against the OLD price (100) but would
  // be valid against a NEW price submitted in the SAME update (60) must be
  // validated against the new one — the price that will actually be in
  // effect once this update lands.
  await updateVariant(sellerId, variantId, { priceBirr: "60.00", compareAtBirr: "80.00" });
  refetched = await getSellerProduct(sellerId, product.id);
  assert.equal(refetched?.variants[0]?.priceSantim, 6_000);
  assert.equal(refetched?.variants[0]?.compareAtSantim, 8_000);

  // And rejected when it's backwards relative to that same new price.
  await assert.rejects(
    () => updateVariant(sellerId, variantId, { priceBirr: "60.00", compareAtBirr: "40.00" }),
    (err: unknown) => err instanceof ListingError && /higher than the actual price/.test(err.message),
  );
});

test("updateProduct sets, then clears, real metaTitle/metaDescription — the write path a dead-field audit found missing", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`seo-${suffix}`);
  const product = await createProduct(sellerId, baseInput(`seo-${suffix}`));

  await updateProduct(sellerId, product.id, {
    metaTitle: "  Real SEO Title  ",
    metaDescription: "  A real, hand-written description for search results.  ",
  });
  let refetched = await getSellerProduct(sellerId, product.id);
  assert.equal(refetched?.metaTitle, "Real SEO Title", "must be trimmed");
  assert.equal(refetched?.metaDescription, "A real, hand-written description for search results.");

  // A blank submission clears it back to null, not a no-op — the product
  // page's own generateMetadata then correctly falls back to title/subtitle.
  await updateProduct(sellerId, product.id, { metaTitle: "", metaDescription: "" });
  refetched = await getSellerProduct(sellerId, product.id);
  assert.equal(refetched?.metaTitle, null);
  assert.equal(refetched?.metaDescription, null);
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

test("updateVariant enqueues a real price-drop check on a genuine decrease, but never on an increase or a no-op update", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const sellerId = await makeSeller(`pricedrop-${suffix}`);
  const product = await createProduct(sellerId, baseInput(`pricedrop-${suffix}`));
  const owned = await getSellerProduct(sellerId, product.id);
  const variantId = owned!.variants[0]!.id;

  // Raising the price must never enqueue anything.
  await updateVariant(sellerId, variantId, { priceBirr: "249.99" });
  const afterIncrease = await prisma.outboxMessage.findMany({ where: { topic: "product.price_dropped" } });
  assert.equal(afterIncrease.filter((m) => (m.payload as { productId: string }).productId === product.id).length, 0);

  // An update that touches other fields but not price must not enqueue either.
  await updateVariant(sellerId, variantId, { active: true });
  const afterNoop = await prisma.outboxMessage.findMany({ where: { topic: "product.price_dropped" } });
  assert.equal(afterNoop.filter((m) => (m.payload as { productId: string }).productId === product.id).length, 0);

  // A genuine decrease is what actually enqueues the real check.
  await updateVariant(sellerId, variantId, { priceBirr: "149.99" });
  const afterDecrease = await prisma.outboxMessage.findMany({ where: { topic: "product.price_dropped" } });
  assert.equal(afterDecrease.filter((m) => (m.payload as { productId: string }).productId === product.id).length, 1);
});

test.after(async () => {
  await prisma.outboxMessage.deleteMany({ where: { topic: "variant.restocked" } });
  await prisma.outboxMessage.deleteMany({ where: { topic: "variant.low_stock" } });
  await prisma.outboxMessage.deleteMany({ where: { topic: "product.price_dropped" } });
  await prisma.backInStockRequest.deleteMany({ where: { variant: { product: { seller: { slug: { startsWith: "listing-test-" } } } } } });
  await prisma.variant.deleteMany({ where: { product: { seller: { slug: { startsWith: "listing-test-" } } } } });
  await prisma.product.deleteMany({ where: { seller: { slug: { startsWith: "listing-test-" } } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "listing-test-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "listing-test-" } } });
  await prisma.$disconnect();
});
