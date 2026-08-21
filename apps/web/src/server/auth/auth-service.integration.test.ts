/**
 * Integration test — requires a real Postgres. Covers `changePassword`,
 * the self-service path distinct from password-reset-service.ts's
 * admin-assisted recovery, and `suspendUser`/`reinstateUser`, the trust &
 * safety enforcement. The properties that matter most for changePassword:
 * the current password is actually verified (not just accepted); the new
 * password really works; a wrong current password changes nothing; and —
 * the one property shared with the reset flow — a successful change
 * destroys every existing session. For suspension: an already-open
 * session is killed immediately, not just future logins; suspension is
 * scoped to CUSTOMER accounts only; double-suspending or reinstating a
 * non-suspended account is rejected; and reinstating clears the
 * suspension cleanly. (The actual login-rejection behavior for a
 * suspended user needs a real Next.js request context for `login()`'s
 * session cookie handling, so that property is verified via real HTTP
 * E2E instead, not here — same reasoning session-store.ts's own module
 * comment documents for why request-context code can't run standalone
 * under a plain test runner.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { changePassword, suspendUser, reinstateUser, deleteOwnAccount, AuthError } from "./auth-service.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { hashToken } from "./session-store.ts";

const prisma = new PrismaClient();

async function makeUser(suffix: string) {
  const passwordHash = await hashPassword("original-password-1");
  return prisma.user.create({
    data: { email: `changepw-user-${suffix}@example.et`, role: "CUSTOMER", passwordHash },
  });
}

test("changing the password with the correct current password works", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);

  await changePassword(user.id, "original-password-1", "brand-new-password-1");

  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(await verifyPassword("original-password-1", updated.passwordHash!), false, "the old password must no longer work");
  assert.equal(await verifyPassword("brand-new-password-1", updated.passwordHash!), true, "the new password must work");
});

test("a wrong current password is rejected and changes nothing", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);

  await assert.rejects(
    () => changePassword(user.id, "totally-wrong-password", "brand-new-password-1"),
    (err: unknown) => err instanceof AuthError && /incorrect/i.test(err.message),
  );

  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(await verifyPassword("original-password-1", unchanged.passwordHash!), true, "the original password must still work");
});

test("a successful change destroys every existing session", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);
  await prisma.session.create({
    data: { userId: user.id, tokenHash: hashToken(`some-session-${suffix}`), expiresAt: new Date(Date.now() + 60_000) },
  });

  await changePassword(user.id, "original-password-1", "brand-new-password-1");

  const remaining = await prisma.session.count({ where: { userId: user.id } });
  assert.equal(remaining, 0, "changing the password must kill every session, including the one that made the request");
});

async function makeCustomer(suffix: string) {
  const passwordHash = await hashPassword("original-password-1");
  return prisma.user.create({
    data: { email: `suspend-user-${suffix}@example.et`, role: "CUSTOMER", passwordHash },
  });
}

test("suspending a customer sets a real suspension record and kills their sessions", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeCustomer(suffix);
  await prisma.session.create({
    data: { userId: user.id, tokenHash: hashToken(`suspend-session-${suffix}`), expiresAt: new Date(Date.now() + 60_000) },
  });

  await suspendUser(user.id, "fraud report", "admin@example.et");

  const suspended = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(suspended.suspendedAt);
  assert.equal(suspended.suspendedReason, "fraud report");
  assert.equal(suspended.suspendedByAdmin, "admin@example.et");

  const remaining = await prisma.session.count({ where: { userId: user.id } });
  assert.equal(remaining, 0, "suspending must kill every open session immediately, not just block future logins");
});

test("suspending an already-suspended account is rejected", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeCustomer(suffix);
  await suspendUser(user.id, "first reason", "admin@example.et");

  await assert.rejects(
    () => suspendUser(user.id, "second reason", "admin@example.et"),
    (err: unknown) => err instanceof AuthError && /already suspended/.test(err.message),
  );
});

test("suspension is scoped to CUSTOMER accounts — a STAFF account is rejected", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const passwordHash = await hashPassword("original-password-1");
  const staff = await prisma.user.create({
    data: { email: `suspend-user-staff-${suffix}@example.et`, role: "STAFF", passwordHash },
  });

  await assert.rejects(
    () => suspendUser(staff.id, "reason", "admin@example.et"),
    (err: unknown) => err instanceof AuthError && /customer accounts/.test(err.message),
  );

  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
  assert.equal(unchanged.suspendedAt, null);
});

test("reinstating a suspended account clears the suspension", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeCustomer(suffix);
  await suspendUser(user.id, "reason", "admin@example.et");

  await reinstateUser(user.id);

  const reinstated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(reinstated.suspendedAt, null);
  assert.equal(reinstated.suspendedReason, null);
  assert.equal(reinstated.suspendedByAdmin, null);
});

test("reinstating an account that isn't suspended is rejected", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeCustomer(suffix);

  await assert.rejects(
    () => reinstateUser(user.id),
    (err: unknown) => err instanceof AuthError && /not suspended/.test(err.message),
  );
});

// Tracked by id, not email prefix — deleteOwnAccount itself REWRITES the
// email to deleted-<userId>@deleted.invalid, so a prefix-based cleanup
// filter on the original "delete-user-" email would miss every row this
// suite's own tests successfully deleted.
const deletableUserIds: string[] = [];

async function makeDeletableUser(suffix: string) {
  const passwordHash = await hashPassword("original-password-1");
  const user = await prisma.user.create({
    data: { email: `delete-user-${suffix}@example.et`, name: "Real Name", phone: `+2519${suffix}`.slice(0, 13), role: "CUSTOMER", passwordHash },
  });
  deletableUserIds.push(user.id);
  return user;
}

test("deleteOwnAccount anonymizes email/name/phone and permanently blocks login", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeDeletableUser(suffix);

  await deleteOwnAccount(user.id, "original-password-1");

  const deleted = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(deleted.email, `deleted-${user.id}@deleted.invalid`);
  assert.equal(deleted.name, null);
  assert.equal(deleted.phone, null);
  assert.equal(deleted.passwordHash, null, "a null passwordHash is what actually blocks login — see login()'s own check");
  assert.ok(deleted.deletedAt);
});

test("deleteOwnAccount with a wrong current password is rejected and changes nothing", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeDeletableUser(suffix);

  await assert.rejects(
    () => deleteOwnAccount(user.id, "totally-wrong-password"),
    (err: unknown) => err instanceof AuthError && /incorrect/i.test(err.message),
  );

  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(unchanged.email, `delete-user-${suffix}@example.et`, "a rejected deletion must not have touched the row");
  assert.equal(unchanged.deletedAt, null);
});

test("deleteOwnAccount destroys every existing session", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeDeletableUser(suffix);
  await prisma.session.create({
    data: { userId: user.id, tokenHash: hashToken(`delete-session-${suffix}`), expiresAt: new Date(Date.now() + 60_000) },
  });

  await deleteOwnAccount(user.id, "original-password-1");

  const remaining = await prisma.session.count({ where: { userId: user.id } });
  assert.equal(remaining, 0);
});

test("deleting an already-deleted account is rejected", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeDeletableUser(suffix);
  await deleteOwnAccount(user.id, "original-password-1");

  await assert.rejects(
    () => deleteOwnAccount(user.id, "original-password-1"),
    (err: unknown) => err instanceof AuthError && /not found/.test(err.message),
  );
});

test("an APPROVED seller cannot self-delete their account — it would strand a real, live storefront", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeDeletableUser(suffix);
  await prisma.seller.create({
    data: { ownerId: user.id, storeName: `Delete Test Store ${suffix}`, slug: `delete-test-store-${suffix}`, status: "APPROVED" },
  });

  await assert.rejects(
    () => deleteOwnAccount(user.id, "original-password-1"),
    (err: unknown) => err instanceof AuthError && /active seller store/.test(err.message),
  );

  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(unchanged.deletedAt, null);
});

test("a PENDING seller (no live storefront) can self-delete freely", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeDeletableUser(suffix);
  await prisma.seller.create({
    data: { ownerId: user.id, storeName: `Delete Test Pending ${suffix}`, slug: `delete-test-pending-${suffix}`, status: "PENDING" },
  });

  await deleteOwnAccount(user.id, "original-password-1");

  const deleted = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(deleted.deletedAt, "a seller application with no live storefront must not block self-deletion");
});

test.after(async () => {
  await prisma.session.deleteMany({ where: { user: { email: { startsWith: "changepw-user-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "changepw-user-" } } });
  await prisma.session.deleteMany({ where: { user: { email: { startsWith: "suspend-user-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "suspend-user-" } } });
  await prisma.session.deleteMany({ where: { userId: { in: deletableUserIds } } });
  await prisma.seller.deleteMany({ where: { ownerId: { in: deletableUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: deletableUserIds } } });
  await prisma.$disconnect();
});
