/**
 * GET /api/metrics — Prometheus scrape target.
 *
 * WHY THIS ROUTE NEEDS AUTH AT ALL
 * A "metrics endpoint" sounds like harmless plumbing, but order volume,
 * checkout failure rates, and gateway latency are real business signals — a
 * competitor or a curious customer scraping this every 15s learns your
 * traffic shape for free. Gated with a bearer token, timing-safe compared.
 *
 * WHY A TOKEN AND NOT A NETWORK POLICY ALONE
 * This app runs metrics on the SAME port as public traffic (Next.js doesn't
 * make standing up a second raw HTTP server easy), so a Kubernetes
 * NetworkPolicy can restrict which PODS reach this port but not which PATH
 * they hit once connected. Belt and suspenders: the token is the real
 * control; infra/k8s's NetworkPolicy additionally restricts the whole app
 * port to the Prometheus namespace at the cluster level. If this service
 * outgrows a single shared port, the correct next step is a dedicated
 * metrics server on its own port (see the curriculum's Phase 9 notes) —
 * not weakening this check.
 */

import { registry } from "@/server/observability/metrics";
import { timingSafeEqual } from "@santim/santimpay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) {
    // Fail closed, same rule as the admin Basic Auth gate: unconfigured
    // means unreachable, never means open.
    return new Response("Metrics endpoint is not configured.", { status: 503 });
  }

  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqual(supplied, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await registry.metrics();
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": registry.contentType },
  });
}
