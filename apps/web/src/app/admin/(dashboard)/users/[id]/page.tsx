import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getUserForAdmin } from "@/server/admin/admin-queries";
import { IssueResetTokenButton } from "@/components/issue-reset-token-button";
import { SuspendUserButton } from "@/components/suspend-user-button";

export const metadata: Metadata = { title: "User detail" };
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminUserDetailPage({ params }: Props) {
  const { id } = await params;
  const user = await getUserForAdmin(id);
  if (!user) notFound();

  return (
    <div style={{ maxWidth: "620px" }}>
      <p style={{ marginBottom: "var(--space-4)" }}>
        <Link href="/admin/users" style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          &larr; Users
        </Link>
      </p>

      <div className="admin-header">
        <h1>{user.email}</h1>
      </div>

      <div className="summary-card" style={{ marginBottom: "var(--space-6)" }}>
        <div className="summary-row">
          <span>Name</span>
          <span>{user.name ?? "—"}</span>
        </div>
        <div className="summary-row">
          <span>Role</span>
          <span>{user.role}</span>
        </div>
        <div className="summary-row">
          <span>Status</span>
          <span>{user.deletedAt ? "Deleted" : user.suspendedAt ? "Suspended" : "Active"}</span>
        </div>
        {user.suspendedAt && user.suspendedReason && (
          <div className="summary-row">
            <span>Suspension reason</span>
            <span>{user.suspendedReason}</span>
          </div>
        )}
        <div className="summary-row">
          <span>Joined</span>
          <span>{user.createdAt.toISOString().slice(0, 10)}</span>
        </div>
        <div className="summary-row">
          <span>Orders</span>
          <span>{user._count.orders}</span>
        </div>
        <div className="summary-row">
          <span>Active sessions</span>
          <span>{user._count.sessions}</span>
        </div>
        {user.seller && (
          <div className="summary-row">
            <span>Seller account</span>
            <span>{user.seller.storeName} ({user.seller.status})</span>
          </div>
        )}
      </div>

      {user.deletedAt ? (
        <p className="form-hint">
          This account was deleted by the user and has no real email or password — account recovery and
          suspension controls don&apos;t apply to it anymore.
        </p>
      ) : (
        <>
          <p style={{ fontWeight: 600, marginBottom: "var(--space-3)" }}>Account recovery</p>
          <p className="form-hint" style={{ marginBottom: "var(--space-3)" }}>
            Only issue a reset link after verifying the request came from this user through a real support
            channel — this system has no email delivery, so it cannot verify that on its own.
          </p>
          <IssueResetTokenButton userId={user.id} userEmail={user.email} />

          {user.role === "CUSTOMER" && (
            <>
              <p style={{ fontWeight: 600, marginTop: "var(--space-6)", marginBottom: "var(--space-3)" }}>
                Trust &amp; safety
              </p>
              <SuspendUserButton userId={user.id} userEmail={user.email} suspended={user.suspendedAt !== null} />
            </>
          )}
        </>
      )}
    </div>
  );
}
