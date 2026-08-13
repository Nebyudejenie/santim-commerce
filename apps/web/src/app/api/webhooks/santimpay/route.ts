/**
 * POST /api/webhooks/santimpay — the `notifyUrl` SantimPay calls.
 *
 * The contract this endpoint must honour:
 *
 *   FAST     — answer in well under 2s. Slow acknowledgement triggers gateway
 *              redelivery, and a redelivery storm during an incident turns a
 *              small problem into a large one. So: verify, persist, return.
 *              Settlement happens on the worker.
 *   HONEST   — 200 means "durably recorded", not "processed". Never return 200
 *              for something we dropped; the gateway would stop retrying.
 *   PARANOID — reject unsigned or stale callbacks with 401. No exceptions, no
 *              "temporarily disabled to debug".
 *   RAW      — read the body as text. Next.js will happily give you a parsed
 *              object, but re-serialising it changes key order and number
 *              formatting, which breaks any body-bound signature check.
 */

import { SantimPaySignatureError } from "@santim/santimpay";
import { recordWebhook } from "@/server/payments/payment-service";
import { logger } from "@/server/observability/logger";
import { webhookRequestsTotal } from "@/server/observability/metrics";

// Never prerender or cache a webhook endpoint.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();

  // RAW body — see the module header.
  const rawBody = await request.text();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  try {
    const result = await recordWebhook(rawBody, headers);

    logger.info("webhook.received", {
      merchantTxnId: result.merchantTxnId,
      duplicate: result.duplicate,
      durationMs: Date.now() - startedAt,
    });

    // 200 with a tiny body. The gateway does not read it; keep it cheap.
    return Response.json({ received: true }, { status: 200 });
  } catch (error) {
    if (error instanceof SantimPaySignatureError) {
      // Do NOT echo the reason back. An attacker probing the endpoint should
      // learn nothing about why their forgery failed.
      logger.error("webhook.signature_rejected", {
        reason: error.message,
        durationMs: Date.now() - startedAt,
      });
      webhookRequestsTotal.inc({ result: "unauthorized" });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // A genuine server-side failure. Return 5xx SO THAT THE GATEWAY RETRIES —
    // returning 200 here would silently drop a real payment notification.
    logger.error("webhook.processing_failed", {
      error: (error as Error).message,
      durationMs: Date.now() - startedAt,
    });
    webhookRequestsTotal.inc({ result: "error" });
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

/** Some gateways probe with GET before enabling a URL. Answer politely. */
export function GET(): Response {
  return Response.json({ ok: true, endpoint: "santimpay-webhook" });
}
