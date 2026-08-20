"use server";

/**
 * Notification mutations — checks its own authorization via requireUser,
 * same in-action-auth discipline as every other action in this codebase.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "../auth/guard.js";
import { markAllAsRead, markAsRead } from "../notifications/notification-service.js";
import { logger } from "../observability/logger.js";

export interface NotificationActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function markNotificationReadAction(
  _prev: NotificationActionState,
  formData: FormData,
): Promise<NotificationActionState> {
  const user = await requireUser();
  const notificationId = String(formData.get("notificationId") ?? "");
  if (!notificationId) return { ok: false, message: "Missing notification id." };

  try {
    await markAsRead(user.id, notificationId);
  } catch (error) {
    logger.error("notification.mark_read_failed", { userId: user.id, notificationId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/account/notifications");
  return { ok: true };
}

// Both parameters are required by useActionState's action signature but
// genuinely unused here — "mark everything read" has no per-item form
// field to read, unlike every other action in this codebase.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function markAllNotificationsReadAction(_prev: NotificationActionState, _formData: FormData): Promise<NotificationActionState> {
  const user = await requireUser();

  try {
    await markAllAsRead(user.id);
  } catch (error) {
    logger.error("notification.mark_all_read_failed", { userId: user.id, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath("/account/notifications");
  return { ok: true };
}
