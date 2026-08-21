"use client";

import { useActionState } from "react";
import {
  hideThreadAction,
  unhideThreadAction,
  type AdminMessagingActionState,
} from "@/server/actions/admin-messaging-actions";

const INITIAL_STATE: AdminMessagingActionState = { ok: false };

export function ThreadModerationActions({ threadId, hidden }: { threadId: string; hidden: boolean }) {
  const [hideState, hideAction, hidePending] = useActionState(hideThreadAction, INITIAL_STATE);
  const [unhideState, unhideAction, unhidePending] = useActionState(unhideThreadAction, INITIAL_STATE);

  if (hidden) {
    return (
      <form action={unhideAction}>
        <input type="hidden" name="threadId" value={threadId} />
        <button type="submit" className="btn btn--primary btn-sm" disabled={unhidePending}>
          {unhidePending ? "…" : "Reopen conversation"}
        </button>
        {unhideState.message && !unhideState.ok && (
          <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{unhideState.message}</p>
        )}
      </form>
    );
  }

  return (
    <form action={hideAction}>
      <input type="hidden" name="threadId" value={threadId} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={hidePending}>
        {hidePending ? "…" : "Close conversation"}
      </button>
      {hideState.message && !hideState.ok && (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>{hideState.message}</p>
      )}
    </form>
  );
}
