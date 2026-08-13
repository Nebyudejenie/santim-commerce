/**
 * Server Component / Server Action authorization guards.
 *
 * These run in the Node.js runtime (any Server Component, Route Handler, or
 * Server Action does) where Prisma works normally — unlike `middleware.ts`,
 * which runs on the Edge runtime by default and cannot talk to Postgres
 * without extra infrastructure (Prisma Accelerate / a driver adapter) this
 * project doesn't have. That's the whole reason authorization lives here,
 * in `(dashboard)/layout.tsx`, rather than in middleware — see that layout's
 * module comment.
 */

import { redirect } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { getSessionUser, type SessionUser } from "./session.js";
import { hasRole } from "./auth-service.js";

/**
 * Redirect to `/admin/login` unless the current session belongs to a user
 * whose role meets `minRole`. Call at the TOP of a layout or page that must
 * be protected — Next.js Server Components run this before rendering any
 * child, so an unauthorized request never even reaches the code that would
 * query orders/payments/reconciliation data.
 */
export async function requireRole(minRole: UserRole): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || !hasRole(user.role, minRole)) {
    redirect("/admin/login");
  }
  return user;
}

/** For customer-facing pages (account, order history) — any logged-in user. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
