"use client";

import { useActionState, useEffect } from "react";
import type { MessageActionState } from "@/server/actions/messaging-actions";

const INITIAL_STATE: MessageActionState = { ok: false };

interface MessageItem {
  id: string;
  body: string;
  createdAt: string;
  fromMe: boolean;
}

/**
 * Shared by both /account/messages/[threadId] and /sell/messages/[threadId]
 * — the buyer and seller sides of a thread render identically, differing
 * only in which Server Action sends/reads for that side (passed in as
 * props, not imported here, so this component stays audience-agnostic).
 *
 * The mount-effect mark-as-read is a deliberate exception to "don't fire
 * actions from render": it runs once per real navigation to this page,
 * not on every render, and crucially NOT during the page's own GET/RSC
 * render — Next.js prefetches links on viewport visibility, so marking
 * read at render time would falsely mark a thread read before the user
 * ever actually opened it.
 */
export function MessageThreadView({
  threadId,
  otherPartyLabel,
  messages,
  sendAction,
  markReadAction,
}: {
  threadId: string;
  otherPartyLabel: string;
  messages: MessageItem[];
  sendAction: (prev: MessageActionState, formData: FormData) => Promise<MessageActionState>;
  markReadAction: (threadId: string) => Promise<void>;
}) {
  const [state, formAction, pending] = useActionState(sendAction, INITIAL_STATE);

  useEffect(() => {
    markReadAction(threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  return (
    <div>
      <div style={{ marginBottom: "var(--space-5)" }}>
        {messages.length === 0 ? (
          <p style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
            No messages yet — say hello to {otherPartyLabel}.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} style={{ marginBottom: "var(--space-3)", textAlign: m.fromMe ? "right" : "left" }}>
              <p
                style={{
                  display: "inline-block",
                  padding: "var(--space-3)",
                  borderRadius: "var(--radius-md)",
                  background: m.fromMe ? "var(--brand)" : "var(--bg-subtle)",
                  color: m.fromMe ? "var(--brand-fg)" : "inherit",
                  maxWidth: "80%",
                  whiteSpace: "pre-wrap",
                  textAlign: "left",
                }}
              >
                {m.body}
              </p>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>
                {new Date(m.createdAt).toLocaleString()}
              </p>
            </div>
          ))
        )}
      </div>

      <form action={formAction}>
        <input type="hidden" name="threadId" value={threadId} />
        <textarea
          name="body"
          placeholder={`Message ${otherPartyLabel}…`}
          required
          minLength={1}
          rows={3}
          style={{ width: "100%", marginBottom: "var(--space-2)" }}
        />
        <button type="submit" className="btn btn--primary btn-sm" disabled={pending}>
          {pending ? "Sending…" : "Send"}
        </button>
        {state.message && !state.ok && <p className="form-hint form-hint--error">{state.message}</p>}
      </form>
    </div>
  );
}
