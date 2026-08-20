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
  suspendSeller,
} from "./seller-service.ts";

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

test.after(async () => {
  await prisma.variant.deleteMany({ where: { product: { slug: { startsWith: "sku-test-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "sku-test-" } } });
  await prisma.seller.deleteMany({ where: { owner: { email: { startsWith: "seller-test-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "seller-test-" } } });
  await prisma.$disconnect();
});
