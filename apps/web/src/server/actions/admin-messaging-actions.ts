"use server";

/**
 * Admin trust & safety actions for buyer-seller order messaging — see
 * message-service.ts's own comment on why `listThreadsForAdmin`/
 * `getThreadForAdmin` are deliberately NOT ownership-scoped, unlike every
 * other query in that module.
 */

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard.js";
import { hideThread, unhideThread } from "../messaging/message-service.js";
import { recordAdminAction } from "../admin/audit-log-service.js";
import { logger } from "../observability/logger.js";

export interface AdminMessagingActionState {
  readonly ok: boolean;
  readonly message?: string;
}

export async function hideThreadAction(
  _prev: AdminMessagingActionState,
  formData: FormData,
): Promise<AdminMessagingActionState> {
  const admin = await requireRole("STAFF");
  const threadId = String(formData.get("threadId") ?? "");

  try {
    await hideThread(threadId);
    await recordAdminAction({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "message_thread.hidden",
      targetType: "MessageThread",
      targetId: threadId,
    });
  } catch (error) {
    logger.error("admin.hide_thread_failed", { threadId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/admin/messages/${threadId}`);
  revalidatePath("/admin/messages");
  return { ok: true, message: "Conversation closed." };
}

export async function unhideThreadAction(
  _prev: AdminMessagingActionState,
  formData: FormData,
): Promise<AdminMessagingActionState> {
  const admin = await requireRole("STAFF");
  const threadId = String(formData.get("threadId") ?? "");

  try {
    await unhideThread(threadId);
    await recordAdminAction({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "message_thread.reopened",
      targetType: "MessageThread",
      targetId: threadId,
    });
  } catch (error) {
    logger.error("admin.unhide_thread_failed", { threadId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  revalidatePath(`/admin/messages/${threadId}`);
  revalidatePath("/admin/messages");
  return { ok: true, message: "Conversation reopened." };
}
