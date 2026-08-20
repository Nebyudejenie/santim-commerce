"use client";

import Link from "next/link";
import { useActionState } from "react";
import { markNotificationReadAction, type NotificationActionState } from "@/server/actions/notification-actions";

const INITIAL_STATE: NotificationActionState = { ok: false };

export interface NotificationItemData {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export function NotificationItem({ notification }: { notification: NotificationItemData }) {
  const [, formAction, pending] = useActionState(markNotificationReadAction, INITIAL_STATE);
  const isUnread = notification.readAt === null;

  return (
    <div className={isUnread ? "notification-row notification-row--unread" : "notification-row"}>
      <div>
        {notification.link ? (
          <Link href={notification.link} className="notification-row__title">{notification.title}</Link>
        ) : (
          <p className="notification-row__title">{notification.title}</p>
        )}
        <p className="notification-row__body">{notification.body}</p>
        <p className="notification-row__meta">{notification.createdAt.toISOString().slice(0, 19).replace("T", " ")}</p>
      </div>
      {isUnread && (
        <form action={formAction}>
          <input type="hidden" name="notificationId" value={notification.id} />
          <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
            {pending ? "…" : "Mark read"}
          </button>
        </form>
      )}
    </div>
  );
}
