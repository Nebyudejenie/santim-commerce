/**
 * Integration test — requires a real Postgres, not a mock. Same discipline
 * as reservation.integration.test.ts: the safety properties proved here
 * (one store per user, unique slugs, unique-per-product SKUs across
 * different sellers) are enforced by real database constraints, which a
 * mocked Prisma client cannot exercise faithfully.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  applyToBecomeSeller,
  approveSeller,
  rejectSeller,
  requireApprovedSeller,
  SellerError,
  setSellerCommission,
  suspendSeller,
  updateSellerProfile,
} from "./seller-service.ts";
import { createLedgerEntriesForOrder } from "../orders/settlement-service.ts";

const prisma = new PrismaClient();

async function makeUser(emailSuffix: string) {
  const user = await prisma.user.create({
    data: { email: `seller-test-${emailSuffix}@example.et`, role: "CUSTOMER" },
  });
  return user.id;
}

async function makeAdmin() {
  const admin = await prisma.user.create({
    data: { email: `seller-test-admin-${Math.random().toString(36).slice(2, 8)}@example.et`, role: "ADMIN" },
  });
  return admin.id;
}

test("applying twice for the same user is rejected, not a silent duplicate", async () => {
  const userId = await makeUser(`dup-${Math.random().toString(36).slice(2, 8)}`);
  await applyToBecomeSeller({ userId, storeName: "First Store Attempt" });

  await assert.rejects(
    () => applyToBecomeSeller({ userId, storeName: "Second Store Attempt" }),
    (err: unknown) => err instanceof SellerError && /already have a seller account/.test(err.message),
  );

  const sellers = await prisma.seller.findMany({ where: { ownerId: userId } });
  assert.equal(sellers.length, 1, "exactly one Seller row must exist for this user");
});

test("two different store names that slugify identically get distinct slugs", async () => {
  const userA = await makeUser(`slugA-${Math.random().toString(36).slice(2, 8)}`);
  const userB = await makeUser(`slugB-${Math.random().toString(36).slice(2, 8)}`);

  const a = await applyToBecomeSeller({ userId: userA, storeName: "Same Name Co" });
  const b = await applyToBecomeSeller({ userId: userB, storeName: "Same Name Co" });

  assert.notEqual(a.slug, b.slug, "colliding slugs must not collide in the database");
  assert.equal(a.slug, "same-name-co");
  assert.equal(b.slug, "same-name-co-2");
});

test("new sellers start PENDING and requireApprovedSeller refuses them", async () => {
  const userId = await makeUser(`pending-${Math.random().toString(36).slice(2, 8)}`);
  await applyToBecomeSeller({ userId, storeName: "Pending Store" });

  await assert.rejects(
    () => requireApprovedSeller(userId),
    (err: unknown) => err instanceof SellerError && /under review/.test(err.message),
  );
});

test("full lifecycle: apply -> approve -> requireApprovedSeller succeeds -> suspend -> refused again", async () => {
  const userId = await makeUser(`lifecycle-${Math.random().toString(36).slice(2, 8)}`);
  const adminId = await makeAdmin();
  const seller = await applyToBecomeSeller({ userId, storeName: "Lifecycle Store" });

  await approveSeller(seller.id, adminId);
  const approved = await requireApprovedSeller(userId);
  assert.equal(approved.status, "APPROVED");

  await suspendSeller(seller.id, adminId);
  await assert.rejects(
    () => requireApprovedSeller(userId),
    (err: unknown) => err instanceof SellerError && /suspended/.test(err.message),
  );

  const row = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
  assert.equal(row.reviewedBy, adminId);
  assert.ok(row.reviewedAt, "reviewedAt must be set by a real state transition");
});

test("rejecting a seller is terminal — cannot later approve it", async () => {
  const userId = await makeUser(`reject-${Math.random().toString(36).slice(2, 8)}`);
  const adminId = await makeAdmin();
  const seller = await applyToBecomeSeller({ userId, storeName: "Rejected Store" });

  await rejectSeller(seller.id, adminId, "Incomplete business documentation.");

  const row = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
  assert.equal(row.status, "REJECTED");
  assert.equal(row.rejectionReason, "Incomplete business documentation.");

  await assert.rejects(() => approveSeller(seller.id, adminId), SellerError);
});

test("two different sellers CAN use the identical SKU on their own products — the whole point of the per-product uniqueness scoping", async () => {
  const userA = await makeUser(`sku-a-${Math.random().toString(36).slice(2, 8)}`);
  const userB = await makeUser(`sku-b-${Math.random().toString(36).slice(2, 8)}`);
  const sellerA = await applyToBecomeSeller({ userId: userA, storeName: "SKU Test Seller A" });
  const sellerB = await applyToBecomeSeller({ userId: userB, storeName: "SKU Test Seller B" });

  const suffix = Math.random().toString(36).slice(2, 8);
  const productA = await prisma.product.create({
    data: { sellerId: sellerA.id, slug: `sku-test-a-${suffix}`, title: "A", description: "d", status: "ACTIVE" },
  });
  const productB = await prisma.product.create({
    data: { sellerId: sellerB.id, slug: `sku-test-b-${suffix}`, title: "B", description: "d", status: "ACTIVE" },
  });

  // Same literal SKU text, two unrelated sellers, two unrelated products —
  // must both succeed. Before the per-product rescoping this would have
  // thrown a unique-constraint violation on the second insert.
  const variantA = await prisma.variant.create({
    data: { productId: productA.id, sku: "SAME-SKU", title: "Only", priceSantim: 1000 },
  });
  const variantB = await prisma.variant.create({
    data: { productId: productB.id, sku: "SAME-SKU", title: "Only", priceSantim: 2000 },
  });

  assert.equal(variantA.sku, "SAME-SKU");
  assert.equal(variantB.sku, "SAME-SKU");
  assert.notEqual(variantA.id, variantB.id);

  // The uniqueness is scoped to (productId, sku), not sellerId — a second
  // variant on the SAME product reusing that SKU must still be rejected.
  await assert.rejects(() =>
    prisma.variant.create({ data: { productId: productA.id, sku: "SAME-SKU", title: "Dup", priceSantim: 999 } }),
  );
});

test("an admin can adjust a seller's commission rate, and it takes real effect on the seller row", async () => {
  const userId = await makeUser(`commission-${Math.random().toString(36).slice(2, 8)}`);
  const adminId = await makeAdmin();
  const seller = await applyToBecomeSeller({ userId, storeName: "Commission Test Store" });
  assert.equal(seller.commissionBps, 1000, "the default is 10% unless changed");

  await setSellerCommission(seller.id, 1500, adminId); // 15%
  const updated = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
  assert.equal(updated.commissionBps, 1500);
});

test("commission adjustment rejects an out-of-range basis-points value", async () => {
  const userId = await makeUser(`commission-bad-${Math.random().toString(36).slice(2, 8)}`);
  const adminId = await makeAdmin();
  const seller = await applyToBecomeSeller({ userId, storeName: "Bad Commission Store" });

  await assert.rejects(
    () => setSellerCommission(seller.id, -100, adminId),
    (err: unknown) => err instanceof SellerError && /basis points/.test(err.message),
  );
  await assert.rejects(
    () => setSellerCommission(seller.id, 10_001, adminId),
    (err: unknown) => err instanceof SellerError && /basis points/.test(err.message),
  );

  const unchanged = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
  assert.equal(unchanged.commissionBps, 1000, "a rejected update must not have touched the row");
});

test("changing a seller's commission does not retroactively alter an already-settled ledger entry", async () => {
  const userId = await makeUser(`commission-retro-${Math.random().toString(36).slice(2, 8)}`);
  const adminId = await makeAdmin();
  const seller = await applyToBecomeSeller({ userId, storeName: "Retro Commission Store" });
  await approveSeller(seller.id, adminId);

  const suffix = Math.random().toString(36).slice(2, 8);
  const buyer = await prisma.user.create({ data: { email: `seller-test-buyer-${suffix}@example.et`, role: "CUSTOMER" } });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `commission-retro-${suffix}`, title: "Item", description: "d", status: "ACTIVE" },
  });
  const variant = await prisma.variant.create({
    data: { productId: product.id, sku: `CR-${suffix}`, title: "Only", priceSantim: 10_000 },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `SC-CRTEST-${suffix}`.toUpperCase(),
      userId: buyer.id,
      email: "buyer@example.et",
      phone: "+251900000000",
      status: "PAID",
      subtotalSantim: 10_000,
      totalSantim: 10_000,
      paidAt: new Date(),
      lines: {
        create: [
          {
            variantId: variant.id,
            sellerId: seller.id,
            sku: `CR-${suffix}`,
            productTitle: "Item",
            variantTitle: "Only",
            unitPriceSantim: 10_000,
            quantity: 1,
            lineTotalSantim: 10_000,
          },
        ],
      },
    },
    include: { lines: true },
  });

  await createLedgerEntriesForOrder(order.id); // settles at the 10% default rate

  await setSellerCommission(seller.id, 5000, adminId); // 50%, well after settlement

  const commissionEntry = await prisma.sellerLedgerEntry.findFirstOrThrow({
    where: { orderLineId: order.lines[0]!.id, type: "COMMISSION" },
  });
  assert.equal(commissionEntry.amountSantim, -1_000, "the entry was computed at the 10% rate in effect at settlement, and must stay that way forever");

  await prisma.sellerLedgerEntry.deleteMany({ where: { orderId: order.id } });
  await prisma.orderLine.deleteMany({ where: { orderId: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
  await prisma.variant.delete({ where: { id: variant.id } });
  await prisma.product.delete({ where: { id: product.id } });
});

test("updateSellerProfile updates storeName/description/logoUrl but never slug", async () => {
  const userId = await makeUser(`profile-${Math.random().toString(36).slice(2, 8)}`);
  const seller = await applyToBecomeSeller({ userId, storeName: "Original Name", description: "Original description" });
  const originalSlug = seller.slug;

  await updateSellerProfile(seller.id, {
    storeName: "  Updated Name  ",
    description: "  Updated description  ",
    logoUrl: "  https://example.et/logo.png  ",
  });

  const updated = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
  assert.equal(updated.storeName, "Updated Name", "must be trimmed");
  assert.equal(updated.description, "Updated description");
  assert.equal(updated.logoUrl, "https://example.et/logo.png");
  assert.equal(updated.slug, originalSlug, "the store URL must never change from a profile edit");
});

test("updateSellerProfile clears description/logoUrl when given blank input", async () => {
  const userId = await makeUser(`profile-clear-${Math.random().toString(36).slice(2, 8)}`);
  const seller = await applyToBecomeSeller({ userId, storeName: "Has Extras", description: "Will be cleared" });
  await prisma.seller.update({ where: { id: seller.id }, data: { logoUrl: "https://example.et/old.png" } });

  await updateSellerProfile(seller.id, { storeName: "Has Extras", description: "", logoUrl: "" });

  const updated = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
  assert.equal(updated.description, null);
  assert.equal(updated.logoUrl, null);
});

test("updateSellerProfile rejects a store name that's too short", async () => {
  const userId = await makeUser(`profile-short-${Math.random().toString(36).slice(2, 8)}`);
  const seller = await applyToBecomeSeller({ userId, storeName: "Valid Name" });

  await assert.rejects(
    () => updateSellerProfile(seller.id, { storeName: "x" }),
    (err: unknown) => err instanceof SellerError && /at least 2 characters/.test(err.message),
  );

  const unchanged = await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } });
  assert.equal(unchanged.storeName, "Valid Name", "a rejected update must not have touched the row");
});

test.after(async () => {
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "sku-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "sku-test-" } } });
  await prisma.seller.deleteMany({ where: { owner: { email: { startsWith: "seller-test-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "seller-test-" } } });
  await prisma.$disconnect();
});
