import Link from "next/link";
import { listThreadsForAdmin } from "@/server/messaging/message-service";

interface Props {
  searchParams: Promise<{ q?: string }>;
}

export default async function AdminMessagesPage({ searchParams }: Props) {
  const { q } = await searchParams;
  const threads = await listThreadsForAdmin(q);

  return (
    <div>
      <div className="admin-header">
        <h1>Buyer-seller messages</h1>
      </div>

      <form className="filter-bar">
        <input type="search" name="q" placeholder="Order number, buyer email, or store name" defaultValue={q ?? ""} />
        <button type="submit" className="btn btn--secondary btn-sm">Search</button>
      </form>

      {threads.length === 0 ? (
        <p className="empty-note">No conversations match this filter.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Buyer</th>
              <th>Seller</th>
              <th>Messages</th>
              <th>Status</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((thread) => (
              <tr key={thread.id}>
                <td>
                  <Link href={`/admin/messages/${thread.id}`}>{thread.order.orderNumber}</Link>
                </td>
                <td>{thread.buyer.name ?? thread.buyer.email}</td>
                <td>{thread.seller.storeName}</td>
                <td>{thread._count.messages}</td>
                <td>{thread.hiddenAt ? "Closed" : "Open"}</td>
                <td>{thread.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
