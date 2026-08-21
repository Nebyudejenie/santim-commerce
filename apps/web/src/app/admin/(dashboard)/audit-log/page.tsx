import type { Metadata } from "next";
import Link from "next/link";
import { listAuditLog } from "@/server/admin/audit-log-service";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

function targetHref(targetType: string, targetId: string): string | null {
  switch (targetType) {
    case "User":
      return `/admin/users/${targetId}`;
    case "Seller":
      return `/admin/sellers`;
    case "Product":
      return `/admin/products`;
    default:
      return null;
  }
}

export default async function AdminAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ targetType?: string; targetId?: string; actorUserId?: string }>;
}) {
  const { targetType, targetId, actorUserId } = await searchParams;
  const entries = await listAuditLog({
    targetType: targetType || undefined,
    targetId: targetId || undefined,
    actorUserId: actorUserId || undefined,
  });

  return (
    <div>
      <div className="admin-header">
        <h1>Audit log</h1>
      </div>
      <p className="form-hint" style={{ marginBottom: "var(--space-5)" }}>
        Every real, sensitive admin action taken on this marketplace — who did what, and when. Most recent
        first, capped at the last 100.
      </p>

      <form method="get" style={{ marginBottom: "var(--space-5)", display: "flex", gap: "var(--space-3)" }}>
        <select name="targetType" defaultValue={targetType ?? ""}>
          <option value="">All target types</option>
          <option value="User">User</option>
          <option value="Seller">Seller</option>
          <option value="Product">Product</option>
          <option value="Payment">Payment</option>
        </select>
        <button type="submit" className="btn btn--secondary btn-sm">Filter</button>
      </form>

      {entries.length === 0 ? (
        <p className="empty-note">No admin actions recorded yet.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const href = targetHref(entry.targetType, entry.targetId);
              return (
                <tr key={entry.id}>
                  <td>{entry.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                  <td>{entry.actorEmail}</td>
                  <td>{entry.action}</td>
                  <td>
                    {href ? (
                      <Link href={href}>{entry.targetType} · {entry.targetId}</Link>
                    ) : (
                      <>{entry.targetType} · {entry.targetId}</>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
