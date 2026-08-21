import type { Metadata } from "next";
import Link from "next/link";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { listThreadsForSeller } from "@/server/messaging/message-service";

export const metadata: Metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

export default async function SellerMessagesPage() {
  const seller = await requireApprovedSellerForPage();
  const threads = await listThreadsForSeller(seller.id);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "620px" }}>
      <h2 style={{ marginBottom: "var(--space-5)" }}>Messages</h2>

      {threads.length === 0 ? (
        <div className="empty-state">
          <h2>No conversations yet</h2>
          <p>Messages from buyers about their orders will show up here.</p>
        </div>
      ) : (
        <div>
          {threads.map((thread) => (
            <Link
              key={thread.id}
              href={`/sell/messages/${thread.id}`}
              className="order-row"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div>
                <p className="order-row__number">
                  {thread.buyer.name ?? thread.buyer.email}
                  {thread.unread && (
                    <span
                      style={{
                        marginLeft: "var(--space-2)",
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "999px",
                        background: "var(--brand)",
                      }}
                      aria-label="Unread"
                    />
                  )}
                </p>
                <p className="order-row__items">Order {thread.order.orderNumber}</p>
              </div>
              <div className="order-row__meta">
                <p>{thread.lastMessageAt.toISOString().slice(0, 10)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
