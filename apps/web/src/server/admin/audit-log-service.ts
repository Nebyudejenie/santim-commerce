/**
 * Cross-entity admin action trail — see schema.prisma's own comment on
 * `AdminAuditLog` for why this exists and why `actorEmail` is a real
 * snapshot, not a live join.
 *
 * `recordAdminAction` is deliberately fire-and-forget from every call
 * site's perspective: it runs AFTER the real action already succeeded, so
 * a logging failure must never be allowed to undo or mask a real
 * mutation that already happened — matches this codebase's own
 * "notifications never gate the state change that triggers them"
 * discipline (see notification-service.ts). It still throws on a genuine
 * failure rather than swallowing silently, because an audit trail that
 * can silently go missing isn't one worth having; callers that want
 * best-effort semantics wrap it themselves, same as recordView's own
 * call site does for recently-viewed tracking.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export interface RecordAdminActionInput {
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata?: Record<string, unknown>;
}

export async function recordAdminAction(input: RecordAdminActionInput): Promise<void> {
  await prisma.adminAuditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

export interface AuditLogFilter {
  readonly targetType?: string;
  readonly targetId?: string;
  readonly actorUserId?: string;
}

export async function listAuditLog(filter: AuditLogFilter = {}, take = 100) {
  return prisma.adminAuditLog.findMany({
    where: {
      targetType: filter.targetType,
      targetId: filter.targetId,
      actorUserId: filter.actorUserId,
    },
    orderBy: { createdAt: "desc" },
    take,
  });
}
