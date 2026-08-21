/**
 * Admin-assisted account recovery.
 *
 * Confirmed absent: this codebase has real email/password auth
 * (auth-service.ts) but never had any way back in for a user who forgets
 * their password — a permanent lockout, for real, since registration.
 *
 * A standard self-service "email me a reset link" flow cannot be honestly
 * built here: notification-service.ts's own comment already establishes
 * that no real email/SMS provider credentials exist in this system, so
 * every "notification" it sends is in-app-only — useless for password
 * recovery specifically, since the whole point is reaching a user who, by
 * definition, cannot sign in to see an in-app notification. Fabricating a
 * "reset email sent" claim when nothing was actually sent would mean
 * presenting fake functionality as real, the same category of problem
 * already avoided this session for carrier tracking numbers and automated
 * seller payouts.
 *
 * This is the honest alternative, matching settlement-service.ts's
 * `recordSellerPayout` precedent: a trusted admin, having verified the
 * request through their own real, off-system channel (a support ticket, a
 * phone call), issues a real, single-use, time-limited token and relays
 * the resulting link to the user themselves. The system never claims to
 * have sent anything — the UI copy says so explicitly.
 *
 * TOKEN HANDLING follows session.ts's own rule exactly: the raw token
 * exists only for the instant it's generated — returned once to the admin
 * who issued it, and in the URL itself. The database only ever sees its
 * SHA-256.
 */

import crypto from "node:crypto";
import { prisma } from "../db.js";
import { hashToken } from "./session-store.js";
import { hashPassword } from "./password.js";
import { destroyAllSessions } from "./session.js";

export class PasswordResetError extends Error {
  override name = "PasswordResetError";
}

// A real reset link should not stay valid indefinitely — long enough for an
// admin to relay it through a real conversation, short enough that a leaked
// link is a narrow window, not a standing account-takeover vector.
const TOKEN_TTL_MS = 60 * 60 * 1000;

export async function issuePasswordResetToken(
  userId: string,
  issuedByAdmin: string,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new PasswordResetError("User not found.");

  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await prisma.$transaction([
    // An earlier unused link for this user must stop working the moment a
    // new one is issued — otherwise old links quietly pile up as still-live
    // account-takeover vectors instead of only ever the latest one working.
    prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: { userId, tokenHash, issuedByAdmin, expiresAt },
    }),
  ]);

  return { rawToken, expiresAt };
}

export async function resetPasswordWithToken(rawToken: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record) throw new PasswordResetError("This reset link is invalid.");
  if (record.usedAt) throw new PasswordResetError("This reset link has already been used.");
  if (record.expiresAt < new Date()) throw new PasswordResetError("This reset link has expired.");

  const passwordHash = await hashPassword(newPassword); // throws PasswordError on weak input — checked before touching the DB

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  // A real security requirement, not optional: resetting the password must
  // kill every existing session — including one an attacker who caused the
  // lockout might already hold.
  await destroyAllSessions(record.userId);
}
