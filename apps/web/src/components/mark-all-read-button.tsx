"use client";

import { useActionState } from "react";
import { markAllNotificationsReadAction, type NotificationActionState } from "@/server/actions/notification-actions";

const INITIAL_STATE: NotificationActionState = { ok: false };

export function MarkAllReadButton() {
  const [, formAction, pending] = useActionState(markAllNotificationsReadAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      <button type="submit" className="btn btn--secondary" disabled={pending}>
        {pending ? "…" : "Mark all as read"}
      </button>
    </form>
  );
}
