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
 * The gateway's `cancelRedirectUrl` target — same reasoning as failed/page.tsx:
 * a cancellation redirect is not authoritative either, so this renders the
 * identical server-truth poller rather than a hardcoded "cancelled" message.
 */
export default async function CancelledPage({ params }: Props) {
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
