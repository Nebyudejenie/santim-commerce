import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { requireApprovedSellerForPage } from "@/server/auth/guard";
import { getThreadForSeller } from "@/server/messaging/message-service";
import { sendSellerMessageAction, markThreadReadAsSellerAction } from "@/server/actions/messaging-actions";
import { MessageThreadView } from "@/components/message-thread-view";

export const metadata: Metadata = { title: "Conversation" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ threadId: string }>;
}

export default async function SellerThreadPage({ params }: Props) {
  const { threadId } = await params;
  const seller = await requireApprovedSellerForPage();
  // Ownership scoped in the query itself — a threadId belonging to another
  // seller resolves to null, same "not found" discipline as
  // getSellerOrderDetail and every other seller-scoped query.
  const thread = await getThreadForSeller(seller.id, threadId);
  if (!thread) notFound();

  const buyerLabel = thread.buyer.name ?? thread.buyer.email;

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "620px" }}>
      <p style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/sell/messages" style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          &larr; Messages
        </Link>
      </p>

      <div className="section-head">
        <h2>{buyerLabel}</h2>
      </div>
      <p style={{ color: "var(--fg-muted)", marginBottom: "var(--space-6)" }}>
        About order{" "}
        <Link href={`/sell/orders/${thread.order.orderNumber}`} style={{ color: "inherit" }}>
          {thread.order.orderNumber}
        </Link>
      </p>

      <MessageThreadView
        threadId={thread.id}
        otherPartyLabel={buyerLabel}
        messages={thread.messages.map((m) => ({
          id: m.id,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          fromMe: m.senderUserId !== thread.buyerUserId,
        }))}
        closed={Boolean(thread.hiddenAt)}
        sendAction={sendSellerMessageAction}
        markReadAction={markThreadReadAsSellerAction}
      />
    </div>
  );
}
