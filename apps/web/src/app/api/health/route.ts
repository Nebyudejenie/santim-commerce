/**
 * Health endpoints.
 *
 * LIVENESS vs READINESS — the distinction that causes real outages when it is
 * collapsed into one endpoint:
 *
 *   /api/health   LIVENESS. "Is this process wedged?" It must NOT touch the
 *                 database. If it did, a brief Postgres blip would fail every
 *                 pod's liveness probe, Kubernetes would restart the entire
 *                 fleet at once, and a 30-second database hiccup becomes a
 *                 full outage with cold caches.
 *
 *   /api/ready    READINESS. "Should this pod receive traffic right now?" This
 *                 one DOES check dependencies. A failing readiness probe
 *                 removes the pod from the load balancer without killing it —
 *                 so it can recover and rejoin.
 *
 * Rule of thumb: liveness failure ⇒ restart me. Readiness failure ⇒ stop
 * sending me traffic. Never let a dependency decide that you should be killed.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  return Response.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
