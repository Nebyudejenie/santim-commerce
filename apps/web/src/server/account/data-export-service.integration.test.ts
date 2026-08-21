/**
 * Integration test — requires a real Postgres. The property that matters
 * most: the export is scoped ENTIRELY to the calling user's own data —
 * another user's order/address/review must never leak in.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { exportUserData } from "./data-export-service.ts";

const prisma = new PrismaClient();

test("exportUserData returns only the calling user's own data, never another user's", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await prisma.user.create({ data: { email: `dataexport-user-${suffix}@example.et`, name: "Real Name", role: "CUSTOMER" } });
  const stranger = await prisma.user.create({ data: { email: `dataexport-stranger-${suffix}@example.et`, role: "CUSTOMER" } });

  await prisma.address.create({
    data: { userId: user.id, fullName: "Real Name", phone: "+251900000000", city: "Addis Ababa", streetLine: "Bole" },
  });
  await prisma.address.create({
    data: { userId: stranger.id, fullName: "Stranger", phone: "+251900000001", city: "Addis Ababa", streetLine: "Piassa" },
  });

  const owner = await prisma.user.create({ data: { email: `dataexport-seller-${suffix}@example.et`, role: "CUSTOMER" } });
  const seller = await prisma.seller.create({
    data: { ownerId: owner.id, storeName: `Data Export Seller ${suffix}`, slug: `dataexport-seller-${suffix}`, status: "APPROVED" },
  });
  const product = await prisma.product.create({
    data: { sellerId: seller.id, slug: `dataexport-product-${suffix}`, title: "Data Export Item", description: "d", status: "ACTIVE" },
  });
  await prisma.wishlistItem.create({ data: { userId: user.id, productId: product.id } });
  await prisma.wishlistItem.create({ data: { userId: stranger.id, productId: product.id } });

  const data = await exportUserData(user.id);

  assert.equal(data.profile.id, user.id);
  assert.equal(data.profile.email, `dataexport-user-${suffix}@example.et`);
  assert.equal(data.addresses.length, 1);
  assert.equal(data.addresses[0]!.city, "Addis Ababa");
  assert.equal(data.wishlist.length, 1);
  assert.equal(data.wishlist[0]!.productId, product.id);
  assert.ok(data.exportedAt);
});

test.after(async () => {
  await prisma.wishlistItem.deleteMany({ where: { product: { slug: { startsWith: "dataexport-product-" } } } });
  await prisma.address.deleteMany({ where: { user: { email: { startsWith: "dataexport-" } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: "dataexport-product-" } } });
  await prisma.seller.deleteMany({ where: { slug: { startsWith: "dataexport-seller-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "dataexport-" } } });
  await prisma.$disconnect();
});
