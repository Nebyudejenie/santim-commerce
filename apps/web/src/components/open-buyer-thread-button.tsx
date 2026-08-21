import { openThreadAsBuyerAction } from "@/server/actions/messaging-actions";

export function OpenBuyerThreadButton({
  orderNumber,
  sellerId,
  sellerName,
}: {
  orderNumber: string;
  sellerId: string;
  sellerName: string;
}) {
  return (
    <form action={openThreadAsBuyerAction} style={{ marginBottom: "var(--space-2)" }}>
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <input type="hidden" name="sellerId" value={sellerId} />
      <button type="submit" className="btn btn--secondary btn-sm">
        Message {sellerName}
      </button>
    </form>
  );
}
