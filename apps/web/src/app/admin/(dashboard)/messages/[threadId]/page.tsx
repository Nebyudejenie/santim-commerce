import { notFound } from "next/navigation";
import Link from "next/link";
import { getThreadForAdmin } from "@/server/messaging/message-service";
import { ThreadModerationActions } from "@/components/thread-moderation-actions";

interface Props {
  params: Promise<{ threadId: string }>;
}

export default async function AdminThreadDetailPage({ params }: Props) {
  const { threadId } = await params;
  // Deliberately not ownership-scoped — see message-service.ts's own
  // comment on why staff needs unrestricted read access to any real
  // conversation on the platform.
  const thread = await getThreadForAdmin(threadId);
  if (!thread) notFound();

  return (
    <div>
      <div className="admin-header">
        <h1>
          {thread.buyer.name ?? thread.buyer.email} &harr; {thread.seller.storeName}
        </h1>
        <ThreadModerationActions threadId={thread.id} hidden={Boolean(thread.hiddenAt)} />
      </div>

      <p style={{ color: "var(--fg-muted)", marginBottom: "var(--space-5)" }}>
        Order {thread.order.orderNumber} · {thread.hiddenAt ? "Closed by an administrator" : "Open"}
      </p>

      {thread.messages.length === 0 ? (
        <p className="empty-note">No messages in this conversation yet.</p>
      ) : (
        <div>
          {thread.messages.map((m) => {
            const fromBuyer = m.senderUserId === thread.buyerUserId;
            return (
              <div key={m.id} style={{ marginBottom: "var(--space-4)" }}>
                <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                  {fromBuyer ? "Buyer" : "Seller"} · {m.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>{m.body}</p>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ marginTop: "var(--space-6)" }}>
        <Link href="/admin/messages" style={{ fontSize: "var(--text-sm)" }}>
          &larr; All conversations
        </Link>
      </p>
    </div>
  );
}
