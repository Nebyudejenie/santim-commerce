/**
 * Session lifecycle: create, verify, destroy, and the httpOnly cookie that
 * carries the raw token. See schema.prisma's Session model doc for why this
 * is database-backed rather than a stateless JWT.
 *
 * TOKEN HANDLING RULE, stated once so every call site can be trusted to
 * follow it: the RAW token exists only in the cookie and in-memory, for the
 * instant it's generated. The DATABASE only ever sees `sha256(token)`. A
 * dump of the sessions table is therefore useless to an attacker — this is
 * the identical principle applied to the SantimPay private key never
 * appearing in logs, and to WHY `Signed-Token` verification is timing-safe
 * (see @santim/santimpay's `timingSafeEqual`).
 */

import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "../db.js";
import { hashToken } from "./session-store.js";
import type { UserRole } from "@prisma/client";

const COOKIE_NAME = "santim_session";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Refresh `expiresAt` at most this often, to avoid a DB write on every request. */
const TOUCH_THRESHOLD_MS = 60 * 60 * 1000;

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: UserRole;
}

/** Create a session row and set the cookie. Call after a verified login/register. */
export async function createSession(userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const requestHeaders = await headers();

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      userAgent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null,
      // Trust only what a reverse proxy under our control sets — see
      // infra/k8s/base/ingress.yaml, which terminates TLS and is the only
      // thing between the internet and this app. A raw client-supplied
      // header here would be trivially spoofable.
      ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    path: "/",
  });
}

/** Verify the current request's session cookie and return the user, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, name: true, role: true } } },
  });

  if (!session || session.expiresAt < new Date()) {
    return null;
  }

  // Sliding expiry, throttled: touching the row on EVERY request would turn
  // every page view into a write. Once an hour is enough to keep an active
  // user's session alive indefinitely without that cost.
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_THRESHOLD_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
  }

  return session.user;
}

/** Destroy the current session, both the cookie and the database row. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  store.delete(COOKIE_NAME);

  if (!token) return;
  // deleteMany, not delete: a stale/already-cleared token must not throw
  // "record not found" — logging out twice is a normal user action, not an error.
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Destroy EVERY session for a user — the "log out all devices" action. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

// Expiry cleanup (`purgeExpiredSessions`) lives in session-store.ts, not
// here, and deliberately has NO re-export from this file — see that
// module's comment. Importing it FROM session.ts, even just to re-export,
// would still load session.ts's own `next/headers` import and defeat the
// entire point for the one caller (the worker) that needs it.
