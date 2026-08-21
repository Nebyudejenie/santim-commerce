import Link from "next/link";
import type { Metadata } from "next";
import { listUsersForAdmin } from "@/server/admin/admin-queries";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const users = await listUsersForAdmin(q);

  return (
    <div>
      <div className="admin-header">
        <h1>Users</h1>
      </div>

      <form method="get" style={{ marginBottom: "var(--space-5)" }}>
        <input type="text" name="q" defaultValue={q ?? ""} placeholder="Search by email or name…" style={{ maxWidth: "320px" }} />
      </form>

      {users.length === 0 ? (
        <p className="empty-note">No users found.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><Link href={`/admin/users/${u.id}`}>{u.email}</Link></td>
                <td>{u.name ?? "—"}</td>
                <td>{u.role}</td>
                <td>{u.deletedAt ? "Deleted" : u.suspendedAt ? "Suspended" : "Active"}</td>
                <td>{u.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
