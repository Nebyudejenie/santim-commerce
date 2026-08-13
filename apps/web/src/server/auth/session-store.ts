/**
 * The Prisma-only half of session handling — hashing and the raw table
 * operations, with NO dependency on `next/headers`/`next/cookies`.
 *
 * WHY THIS SPLIT EXISTS: `session.ts` imports `next/headers`, which only
 * resolves inside Next's own request pipeline (a Server Component, Route
 * Handler, or Server Action). The background worker (src/worker/index.ts) is
 * a plain Node process outside that pipeline entirely — importing
 * `next/headers` there fails at module load, not at call time, which was
 * confirmed the hard way: `node --experimental-strip-types` throws
 * `Cannot find module '.../node_modules/next/headers'` the instant anything
 * pulls that module in, even if the actual cookie-touching function is never
 * called. Any session logic the worker needs — today, just expiry cleanup —
 * has to live here, not in session.ts, or the worker container crashes on boot.
 */

import crypto from "node:crypto";
import { prisma } from "../db.js";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Housekeeping: called from the worker's tick loop, not on the request path. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
