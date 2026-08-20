import Link from "next/link";
import { getDashboardStats } from "@/server/admin/admin-queries";
import { format } from "@santim/santimpay/money";
import type { Santim } from "@santim/santimpay/money";

// Without this, Next statically prerenders this page at BUILD time — no
// searchParams or dynamic segment here to force dynamic rendering the way
// /admin/orders (searchParams) and /admin/orders/[id] (route param) get it
// automatically. A frozen snapshot of "orders today" and "stuck payments" is
// actively dangerous on a dashboard whose entire job is showing what's true
// right now.
export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const stats = await getDashboardStats();

  return (
    <div>
      <div className="admin-header">
        <h1>Dashboard</h1>
      </div>

      <div className="stat-grid">
        <div className="stat-tile">
          <p className="stat-tile__label">Orders today</p>
          <p className="stat-tile__value">{stats.ordersToday}</p>
        </div>
        <div className="stat-tile">
          <p className="stat-tile__label">Paid today</p>
          <p className="stat-tile__value">{stats.paidToday}</p>
        </div>
        <div className="stat-tile">
          <p className="stat-tile__label">Revenue today</p>
          <p className="stat-tile__value">{format(stats.revenueTodaySantim as Santim)}</p>
        </div>
        <div className="stat-tile stat-tile--warn" data-alert={stats.stuckPayments > 0}>
          <p className="stat-tile__label">Stuck payments (&gt;20m)</p>
          <p className="stat-tile__value">{stats.stuckPayments}</p>
        </div>
        <div className="stat-tile stat-tile--warn" data-alert={stats.pendingReservationsExpiringSoon > 0}>
          <p className="stat-tile__label">Reservations expiring &lt;5m</p>
          <p className="stat-tile__value">{stats.pendingReservationsExpiringSoon}</p>
        </div>
      </div>

      {stats.stuckPayments > 0 && (
        <p className="alert alert--error">
          {stats.stuckPayments} payment{stats.stuckPayments === 1 ? "" : "s"} unresolved for over 20 minutes.{" "}
          <Link href="/admin/reconciliation">Review the reconciliation queue →</Link>
        </p>
      )}

      <p className="empty-note">
        This mirrors what the background worker checks on every tick (see src/worker/index.ts) —
        payments the poller hasn&apos;t resolved and reservations about to expire.
      </p>
    </div>
  );
}
