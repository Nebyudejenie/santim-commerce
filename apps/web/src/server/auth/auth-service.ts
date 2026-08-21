/**
 * Registration and login. Deliberately thin — the actual security work
 * (hashing, timing-safe comparison, session issuance) lives in password.ts
 * and session.ts; this module is the orchestration and the error taxonomy.
 */

import type { UserRole } from "@prisma/client";
import { prisma } from "../db.js";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { createSession, destroyAllSessions, destroySession } from "./session.js";
import { logger } from "../observability/logger.js";

export class AuthError extends Error {
  override name = "AuthError";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly role: UserRole;
}

export async function register(input: RegisterInput): Promise<AuthenticatedUser> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError("Enter a valid email address.");
  }

  const passwordHash = await hashPassword(input.password); // throws PasswordError on weak input

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, name: input.name?.trim() || null, role: "CUSTOMER" },
    });
    await createSession(user.id);
    logger.info("auth.registered", { userId: user.id });
    return { id: user.id, role: user.role };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Deliberately the same message a wrong-password login would show —
      // see login()'s comment on why login itself must not distinguish
      // these cases. Registration is allowed to be specific: telling
      // someone "this email already has an account" here is the ordinary,
      // expected UX (and the alternative — silently doing nothing — mostly
      // just confuses people who mistyped their password on signup).
      throw new AuthError("An account with this email already exists. Try logging in instead.");
    }
    throw error;
  }
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Verify credentials and start a session.
 *
 * SAME ERROR FOR "no such user" AND "wrong password" — distinguishing them
 * lets an attacker enumerate which emails have accounts, one login attempt
 * at a time. The dummy-hash comparison below also keeps the TIMING the same
 * in both cases: without it, "no such user" returns near-instantly while
 * "wrong password" takes ~50-100ms (scrypt's cost), and that gap alone is
 * enough to enumerate accounts even with an identical error message.
 */
export async function login(input: LoginInput): Promise<AuthenticatedUser> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });

  const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
  const valid = await verifyPassword(input.password, hashToCheck);

  if (!user || !user.passwordHash || !valid) {
    logger.warn("auth.login_failed", { email });
    throw new AuthError("Incorrect email or password.");
  }

  // Checked only AFTER the password has already been proven correct — the
  // same reasoning adminLoginAction's own "you don't have admin access"
  // message already relies on in this codebase: revealing suspension here
  // isn't an enumeration risk, since whoever just typed the right password
  // already knows this account exists.
  if (user.suspendedAt) {
    logger.warn("auth.login_blocked_suspended", { userId: user.id });
    throw new AuthError("This account has been suspended. Contact support for help.");
  }

  if (needsRehash(user.passwordHash)) {
    const rehashed = await hashPassword(input.password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: rehashed } });
  }

  await createSession(user.id);
  logger.info("auth.login", { userId: user.id });
  return { id: user.id, role: user.role };
}

export async function logout(): Promise<void> {
  await destroySession();
}

/**
 * Self-service password change for an already-authenticated user —
 * distinct from password-reset-service.ts's admin-assisted RECOVERY flow
 * for a user who's locked out. No enumeration concern here the way
 * login() has: the caller already proved who they are via a real session
 * (requireUser(), enforced at the Server Action), so there's no "which
 * email exists" question to protect against.
 *
 * Same real security requirement as the reset flow: a successful change
 * destroys EVERY existing session, this one included, and the caller
 * re-authenticates via a fresh login — the one existing precedent for
 * "something just changed the password" in this codebase.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) {
    throw new AuthError("Account not found.");
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    throw new AuthError("Current password is incorrect.");
  }

  const newHash = await hashPassword(newPassword); // throws PasswordError on weak input
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });
  await destroyAllSessions(userId);

  logger.info("auth.password_changed", { userId });
}

/**
 * A hash of a fixed, never-used password. Verifying against this for an
 * unknown email costs the same scrypt computation as a real check, which is
 * the entire point — see login()'s module comment on timing. Not a secret —
 * it protects nothing on its own — so a fixed salt is fine; it only needs to
 * be a well-formed hash of the current KEY_LENGTH/params, which generating it
 * via the real `hashPassword` code path (rather than typing hex by hand)
 * guarantees.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$42424242424242424242424242424242$" +
  "7486f8795dd71d5a80c50ff3f6dcf5e63b24782b83729bd439098415b1b0bd5a5d3960a0f38bd611390b1d0cb1bd516984586a364c76a02c54d0f39b176ab28e";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/**
 * Trust & safety enforcement — see schema.prisma's own comment on
 * `User.suspendedAt` for why this is a separate, independent concern from
 * Seller.status's existing suspend/reinstate. Scoped to CUSTOMER-role
 * accounts only: suspending a STAFF/ADMIN account through this same,
 * simple admin-facing flow is deliberately not offered here — that is a
 * more sensitive action this v1 does not build a UI for.
 */
export async function suspendUser(userId: string, reason: string, suspendedByAdmin: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError("User not found.");
  if (user.role !== "CUSTOMER") throw new AuthError("Only customer accounts can be suspended here.");
  if (user.suspendedAt) throw new AuthError("This account is already suspended.");

  await prisma.user.update({
    where: { id: userId },
    data: { suspendedAt: new Date(), suspendedReason: reason.trim() || null, suspendedByAdmin },
  });
  // Not just future logins — force out a session that's open right now.
  await destroyAllSessions(userId);

  logger.warn("auth.user_suspended", { userId, suspendedByAdmin });
}

export async function reinstateUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError("User not found.");
  if (!user.suspendedAt) throw new AuthError("This account is not suspended.");

  await prisma.user.update({
    where: { id: userId },
    data: { suspendedAt: null, suspendedReason: null, suspendedByAdmin: null },
  });

  logger.info("auth.user_reinstated", { userId });
}

/** Role hierarchy for the admin gate: ADMIN can do everything STAFF can. */
const ROLE_RANK: Record<UserRole, number> = { CUSTOMER: 0, STAFF: 1, ADMIN: 2 };

export function hasRole(role: UserRole, required: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
