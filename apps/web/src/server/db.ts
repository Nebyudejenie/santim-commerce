/**
 * Prisma client singleton.
 *
 * Next.js dev mode hot-reloads modules on every edit. A `new PrismaClient()` at
 * module scope therefore creates a NEW connection pool on every save, and
 * within a minute of editing you exhaust `max_connections` on Postgres and see
 * "too many clients already" — an error that looks like a database problem and
 * is actually a module-lifecycle problem. Caching on `globalThis` survives the
 * reload because the global object is not re-created.
 */

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
