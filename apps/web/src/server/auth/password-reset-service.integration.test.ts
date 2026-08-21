/**
 * Integration test — requires a real Postgres. The properties that matter
 * most: a real token resets a real password (old password no longer works,
 * new one does); resetting kills every existing session, including one an
 * attacker might already hold; a token can be used exactly once; an
 * expired token is rejected; issuing a second token invalidates the first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { issuePasswordResetToken, resetPasswordWithToken, PasswordResetError } from "./password-reset-service.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { hashToken } from "./session-store.ts";

const prisma = new PrismaClient();

async function makeUser(suffix: string) {
  const passwordHash = await hashPassword("original-password-1");
  return prisma.user.create({
    data: { email: `reset-user-${suffix}@example.et`, role: "CUSTOMER", passwordHash },
  });
}

test("issuing and redeeming a token resets the real password", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);

  const { rawToken } = await issuePasswordResetToken(user.id, "admin@example.et");
  await resetPasswordWithToken(rawToken, "brand-new-password-1");

  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(await verifyPassword("original-password-1", updated.passwordHash!), false, "the old password must no longer work");
  assert.equal(await verifyPassword("brand-new-password-1", updated.passwordHash!), true, "the new password must work");
});

test("resetting the password destroys every existing session", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);
  await prisma.session.create({
    data: { userId: user.id, tokenHash: hashToken(`attacker-session-${suffix}`), expiresAt: new Date(Date.now() + 60_000) },
  });

  const { rawToken } = await issuePasswordResetToken(user.id, "admin@example.et");
  await resetPasswordWithToken(rawToken, "brand-new-password-1");

  const remaining = await prisma.session.count({ where: { userId: user.id } });
  assert.equal(remaining, 0, "a password reset must kill every session, including one an attacker already holds");
});

test("a token can be redeemed exactly once", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);

  const { rawToken } = await issuePasswordResetToken(user.id, "admin@example.et");
  await resetPasswordWithToken(rawToken, "brand-new-password-1");

  await assert.rejects(
    () => resetPasswordWithToken(rawToken, "another-password-2"),
    (err: unknown) => err instanceof PasswordResetError && /already been used/.test(err.message),
  );
});

test("an expired token is rejected", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);

  const { rawToken } = await issuePasswordResetToken(user.id, "admin@example.et");
  await prisma.passwordResetToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

  await assert.rejects(
    () => resetPasswordWithToken(rawToken, "brand-new-password-1"),
    (err: unknown) => err instanceof PasswordResetError && /expired/.test(err.message),
  );
});

test("an unknown token is rejected", async () => {
  await assert.rejects(
    () => resetPasswordWithToken("not-a-real-token", "brand-new-password-1"),
    (err: unknown) => err instanceof PasswordResetError && /invalid/.test(err.message),
  );
});

test("issuing a second token invalidates the first", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = await makeUser(suffix);

  const first = await issuePasswordResetToken(user.id, "admin@example.et");
  await issuePasswordResetToken(user.id, "admin@example.et"); // a second, later request for the same user

  await assert.rejects(
    () => resetPasswordWithToken(first.rawToken, "brand-new-password-1"),
    (err: unknown) => err instanceof PasswordResetError && /already been used/.test(err.message),
  );
});

test("issuing a token for a nonexistent user is rejected", async () => {
  await assert.rejects(
    () => issuePasswordResetToken("no-such-user-id", "admin@example.et"),
    (err: unknown) => err instanceof PasswordResetError && /not found/.test(err.message),
  );
});

test.after(async () => {
  await prisma.passwordResetToken.deleteMany({ where: { user: { email: { startsWith: "reset-user-" } } } });
  await prisma.session.deleteMany({ where: { user: { email: { startsWith: "reset-user-" } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "reset-user-" } } });
  await prisma.$disconnect();
});
