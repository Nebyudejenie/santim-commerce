import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getOrderStatus } from "@/server/orders/get-order-status";
import { OrderConfirmation } from "@/components/order-confirmation";

export const metadata: Metadata = { title: "Confirming your order" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ orderNumber: string }>;
}

export default async function ConfirmingPage({ params }: Props) {
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
