import Link from "next/link";
import { listOrders, type OrderStatus } from "@/server/admin/admin-queries";
import { StatusPill } from "@/components/status-pill";
import { Money } from "@/components/money";

interface Props {
  searchParams: Promise<{ status?: string; q?: string }>;
}

const STATUSES: OrderStatus[] = [
  "PENDING_PAYMENT", "PAID", "FAILED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED",
];

export default async function AdminOrdersPage({ searchParams }: Props) {
  const { status, q } = await searchParams;
  const orders = await listOrders({
    status: status as OrderStatus | undefined,
    search: q,
  });

  const exportParams = new URLSearchParams();
  if (status) exportParams.set("status", status);
  if (q) exportParams.set("q", q);
  const exportHref = `/admin/orders/export${exportParams.toString() ? `?${exportParams.toString()}` : ""}`;

  return (
    <div>
      <div className="admin-header">
        <h1>Orders</h1>
        <Link href={exportHref} className="btn btn--secondary btn-sm">Export CSV</Link>
      </div>

      <form className="filter-bar">
        <input type="search" name="q" placeholder="Order number or email" defaultValue={q ?? ""} />
        <select name="status" defaultValue={status ?? ""}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <button type="submit" className="btn btn--secondary btn-sm">Filter</button>
      </form>

      {orders.length === 0 ? (
        <p className="empty-note">No orders match this filter.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Fulfilment</th>
              <th>Total</th>
              <th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link href={`/admin/orders/${order.orderNumber}`}>{order.orderNumber}</Link>
                </td>
                <td>{order.email}</td>
                <td><StatusPill status={order.status} /></td>
                <td><StatusPill status={order.fulfilmentStatus} /></td>
                <td><Money santim={order.totalSantim} /></td>
                <td>{order.placedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
