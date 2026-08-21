/**
 * Integration test — requires a real Postgres. The property that matters
 * most: `actorEmail` is a real, independent snapshot — it must keep
 * reading the email the admin actually had AT THE TIME of the action,
 * never a live join, since this session's own self-service account
 * deletion can anonymize ANY user's email later, admins included.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { recordAdminAction, listAuditLog } from "./audit-log-service.ts";

const prisma = new PrismaClient();

async function makeAdmin(suffix: string) {
  const admin = await prisma.user.create({ data: { email: `audit-admin-${suffix}@example.et`, role: "STAFF" } });
  return admin;
}

test("recordAdminAction persists a real, queryable entry with the given metadata", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const admin = await makeAdmin(suffix);

  await recordAdminAction({
    actorUserId: admin.id,
    actorEmail: admin.email,
    action: "user.suspended",
    targetType: "User",
    targetId: `target-${suffix}`,
    metadata: { reason: "fraud report" },
  });

  const entries = await listAuditLog({ targetType: "User", targetId: `target-${suffix}` });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.actorEmail, admin.email);
  assert.equal(entries[0]!.action, "user.suspended");
  assert.deepEqual(entries[0]!.metadata, { reason: "fraud report" });
});

test("actorEmail is a real snapshot — it keeps reading the original value even after the admin's own account is later anonymized", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const admin = await makeAdmin(suffix);
  const originalEmail = admin.email;

  await recordAdminAction({
    actorUserId: admin.id,
    actorEmail: originalEmail,
    action: "seller.approved",
    targetType: "Seller",
    targetId: `seller-${suffix}`,
  });

  // Simulates what self-service account deletion does to a User row —
  // the audit entry must not follow this change.
  await prisma.user.update({ where: { id: admin.id }, data: { email: `deleted-${admin.id}@deleted.invalid` } });

  const entries = await listAuditLog({ targetType: "Seller", targetId: `seller-${suffix}` });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.actorEmail, originalEmail, "the audit trail must keep saying who really did this at the time");
});

test("listAuditLog filters by actorUserId, and orders most-recent-first", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const adminA = await makeAdmin(`${suffix}-a`);
  const adminB = await makeAdmin(`${suffix}-b`);

  await recordAdminAction({ actorUserId: adminA.id, actorEmail: adminA.email, action: "seller.suspended", targetType: "Seller", targetId: `filter-${suffix}` });
  await recordAdminAction({ actorUserId: adminB.id, actorEmail: adminB.email, action: "seller.approved", targetType: "Seller", targetId: `filter-${suffix}` });

  const forA = await listAuditLog({ actorUserId: adminA.id });
  assert.ok(forA.every((e) => e.actorUserId === adminA.id));
  assert.ok(forA.some((e) => e.targetId === `filter-${suffix}`));

  const both = await listAuditLog({ targetType: "Seller", targetId: `filter-${suffix}` });
  assert.equal(both.length, 2);
  assert.ok(both[0]!.createdAt >= both[1]!.createdAt, "most recent must come first");
});

test.after(async () => {
  await prisma.adminAuditLog.deleteMany({ where: { actorEmail: { startsWith: "audit-admin-" } } });
  await prisma.adminAuditLog.deleteMany({ where: { actorEmail: { startsWith: "deleted-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "audit-admin-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "deleted-" }, role: "STAFF" } });
  await prisma.$disconnect();
});
