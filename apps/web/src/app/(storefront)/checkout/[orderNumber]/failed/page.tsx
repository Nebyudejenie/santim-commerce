import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getOrderStatus } from "@/server/orders/get-order-status";
import { OrderConfirmation } from "@/components/order-confirmation";

export const metadata: Metadata = { title: "Payment status" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ orderNumber: string }>;
}

/**
 * The gateway's `failureRedirectUrl` target.
 *
 * Deliberately renders the SAME poller as the success page rather than
 * immediately declaring failure. The redirect-is-not-proof rule (protocol
 * spec §5.2) cuts both ways: a browser landing here proves the customer's
 * device was TOLD the payment failed, not that our backend has confirmed it.
 * A flaky redirect, a "Duplicate Client Reference" retry that actually
 * succeeded, or a channel that resolves a few seconds late could all land the
 * browser here while the real, server-confirmed outcome is still pending or
 * even COMPLETED. Only the polled `/api/orders/:id/status` — driven by the
 * Transaction Status API, never the URL we arrived on — decides what renders.
 */
export default async function FailedPage({ params }: Props) {
  const { orderNumber } = await params;
  const order = await getOrderStatus(orderNumber);
  if (!order) notFound();

  return (
    <div className="container">
      <OrderConfirmation
        initial={{
          orderNumber: order.orderNumber,
          status: order.status,
          totalSantim: order.totalSantim,
          paid: order.paidAt !== null,
        }}
      />
    </div>
  );
}
