/**
 * Integration test — requires a real Postgres. Covers `changePassword`,
 * the self-service path distinct from password-reset-service.ts's
 * admin-assisted recovery. The properties that matter most: the current
 * password is actually verified (not just accepted); the new password
 * really works; a wrong current password changes nothing; and — the one
 * property shared with the reset flow — a successful change destroys
 * every existing session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { changePassword, AuthError } from "./auth-service.ts";
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

test.after(async () => {
  await prisma.session.deleteMany({ where: { user: { email: { startsWith: "changepw-user-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "changepw-user-" } } });
  await prisma.$disconnect();
});
