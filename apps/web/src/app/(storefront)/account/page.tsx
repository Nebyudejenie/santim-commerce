import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guard";
import { getOrdersForUser } from "@/server/orders/get-user-orders";
import { logoutAction } from "@/server/actions/auth-actions";
import { Money } from "@/components/money";
import { StatusPill } from "@/components/status-pill";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ q?: string }>;
}

export default async function AccountPage({ searchParams }: Props) {
  const { q } = await searchParams;
  const user = await requireUser();
  const orders = await getOrdersForUser(user.id, q);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "760px" }}>
      <div className="section-head">
        <h2>Your orders</h2>
        <form action={logoutAction}>
          <button type="submit" className="btn btn--secondary">Sign out</button>
        </form>
      </div>

      <p style={{ color: "var(--fg-muted)", marginBottom: "var(--space-4)" }}>
        Signed in as {user.email}
      </p>

      <div style={{ display: "flex", gap: "var(--space-3)", marginBottom: "var(--space-6)" }}>
        <Link href="/account/addresses" className="btn btn--secondary">Manage addresses</Link>
        <Link href="/account/wishlist" className="btn btn--secondary">Your wishlist</Link>
        <Link href="/account/security" className="btn btn--secondary">Password</Link>
      </div>

      <form method="get" style={{ marginBottom: "var(--space-5)", display: "flex", gap: "var(--space-3)" }}>
        <input type="text" name="q" defaultValue={q ?? ""} placeholder="Order number or item name…" style={{ maxWidth: "280px" }} />
        <button type="submit" className="btn btn--secondary btn-sm">Search</button>
      </form>

      {orders.length === 0 ? (
        <div className="empty-state">
          <h2>{q ? "No matching orders" : "No orders yet"}</h2>
          <p style={{ marginBottom: "var(--space-6)" }}>
            {q ? "Try a different search." : "When you place an order, it'll show up here."}
          </p>
          {!q && <Link href="/shop" className="btn btn--primary">Start shopping</Link>}
        </div>
      ) : (
        <div>
          {orders.map((order) => (
            <Link
              key={order.orderNumber}
              href={`/account/orders/${order.orderNumber}`}
              className="order-row"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div>
                <p className="order-row__number">{order.orderNumber}</p>
                <p className="order-row__items">
                  {order.lines.map((l) => `${l.productTitle} (${l.quantity})`).join(", ")}
                </p>
              </div>
              <div className="order-row__meta">
                <p className="order-row__total"><Money santim={order.totalSantim} /></p>
                <StatusPill status={order.status} />
                <p>{order.placedAt.toISOString().slice(0, 10)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
