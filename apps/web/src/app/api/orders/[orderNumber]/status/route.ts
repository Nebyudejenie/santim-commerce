/**
 * GET /api/orders/:orderNumber/status — polled by the client-side confirming
 * page while the payment settles asynchronously (webhook + poller + worker;
 * see docs/01-santimpay-protocol-spec.md §5.4).
 *
 * Deliberately returns ONLY status + total, never email/address/line items —
 * this endpoint has no authentication (a customer polls it right after being
 * redirected back from the gateway, before any login exists), so it must be
 * safe to call knowing only the order number. Order numbers are Crockford
 * Base32 over a 32^8 keyspace specifically so they are not practically
 * guessable — see order-number.ts.
 *
 * NOT rate-limited here — that belongs at the edge/proxy layer (Phase 10 in
 * the curriculum), not duplicated into every route handler.
 */

import { getOrderStatus } from "@/server/orders/get-order-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Params {
  params: Promise<{ orderNumber: string }>;
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { orderNumber } = await params;
  const order = await getOrderStatus(orderNumber);

  if (!order) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({
    orderNumber: order.orderNumber,
    status: order.status,
    totalSantim: order.totalSantim,
    paid: order.paidAt !== null,
  });
}
