import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guard";
import { listNotificationsForUser } from "@/server/notifications/notification-service";
import { NotificationItem } from "@/components/notification-item";
import { MarkAllReadButton } from "@/components/mark-all-read-button";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireUser();
  const notifications = await listNotificationsForUser(user.id);
  const hasUnread = notifications.some((n) => n.readAt === null);

  return (
    <div className="container" style={{ paddingBlock: "var(--space-7)", maxWidth: "620px" }}>
      <div className="section-head">
        <h2>Notifications</h2>
        {hasUnread && <MarkAllReadButton />}
      </div>

      {notifications.length === 0 ? (
        <div className="empty-state">
          <h2>No notifications yet</h2>
          <p>Updates about your orders and returns will show up here.</p>
        </div>
      ) : (
        <div>
          {notifications.map((n) => (
            <NotificationItem key={n.id} notification={n} />
          ))}
        </div>
      )}
    </div>
  );
}
