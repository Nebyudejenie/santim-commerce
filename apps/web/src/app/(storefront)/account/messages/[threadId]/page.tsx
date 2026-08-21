import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guard";
import { getThreadForBuyer } from "@/server/messaging/message-service";
import { sendBuyerMessageAction, markThreadReadAsBuyerAction } from "@/server/actions/messaging-actions";
import { MessageThreadView } from "@/components/message-thread-view";

export const metadata: Metadata = { title: "Conversation" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ threadId: string }>;
}

export default async function BuyerThreadPage({ params }: Props) {
  const { threadId } = await params;
  const user = await requireUser();
  // Ownership scoped in the query itself — a threadId that isn't this
  // buyer's own resolves to null, same "not found" discipline as every
  // other ownership-scoped query in this codebase.
  const thread = await getThreadForBuyer(user.id, threadId);
  if (!thread) notFound();

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "620px" }}>
      <p style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/account/messages" style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          &larr; Messages
        </Link>
      </p>

      <div className="section-head">
        <h2>{thread.seller.storeName}</h2>
      </div>
      <p style={{ color: "var(--fg-muted)", marginBottom: "var(--space-6)" }}>
        About order{" "}
        <Link href={`/account/orders/${thread.order.orderNumber}`} style={{ color: "inherit" }}>
          {thread.order.orderNumber}
        </Link>
      </p>

      <MessageThreadView
        threadId={thread.id}
        otherPartyLabel={thread.seller.storeName}
        messages={thread.messages.map((m) => ({
          id: m.id,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          fromMe: m.senderUserId === user.id,
        }))}
        closed={Boolean(thread.hiddenAt)}
        sendAction={sendBuyerMessageAction}
        markReadAction={markThreadReadAsBuyerAction}
      />
    </div>
  );
}
