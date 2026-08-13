/**
 * Readiness probe — see the comment in ../health/route.ts for why this is a
 * separate endpoint from liveness.
 *
 * Checks that we can actually serve: configuration parsed, database reachable.
 * Returns 503 when it cannot, which removes this pod from the load balancer
 * without restarting it.
 */

import { prisma } from "@/server/db";
import { env } from "@/server/config/env";
import { logger } from "@/server/observability/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const checks: Record<string, "ok" | "fail"> = {};

  try {
    env();
    checks["config"] = "ok";
  } catch (error) {
    checks["config"] = "fail";
    logger.error("ready.config_invalid", { error: (error as Error).message });
  }

  try {
    // A trivial query, with its own deadline. A readiness probe that can hang
    // is worse than no probe at all — the kubelet's timeout fires, but you have
    // still tied up a connection from a pool that is already struggling.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
    ]);
    checks["database"] = "ok";
  } catch (error) {
    checks["database"] = "fail";
    logger.error("ready.database_unreachable", { error: (error as Error).message });
  }

  const ready = Object.values(checks).every((v) => v === "ok");
  return Response.json({ ready, checks }, { status: ready ? 200 : 503 });
}
