import { openThreadAsSellerAction } from "@/server/actions/messaging-actions";

export function OpenSellerThreadButton({ orderNumber }: { orderNumber: string }) {
  return (
    <form action={openThreadAsSellerAction} style={{ marginTop: "var(--space-4)" }}>
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <button type="submit" className="btn btn--secondary btn-sm">
        Message the buyer
      </button>
    </form>
  );
}
