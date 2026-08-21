import Link from "next/link";
import { requireRole } from "@/server/auth/guard";
import { logoutAction } from "@/server/actions/auth-actions";

/**
 * The actual admin authorization boundary. `requireRole("STAFF")` redirects
 * to `/admin/login` before rendering anything below this layout — dashboard,
 * orders, order detail, reconciliation all inherit it automatically because
 * they're all children of this route segment. Adding a new protected admin
 * page later means putting it under `(dashboard)/`; it does not need its
 * own auth check.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("STAFF");

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <span className="admin-sidebar__mark">LUMEN Admin</span>
        <nav>
          <Link href="/admin">Dashboard</Link>
          <Link href="/admin/orders">Orders</Link>
          <Link href="/admin/sellers">Sellers</Link>
          <Link href="/admin/products">Products</Link>
          <Link href="/admin/reviews">Reviews</Link>
          <Link href="/admin/returns">Returns</Link>
          <Link href="/admin/coupons">Coupons</Link>
          <Link href="/admin/reconciliation">Reconciliation</Link>
        </nav>
        <div className="admin-sidebar__user">
          <p className="admin-sidebar__user-email">{user.email}</p>
          <p className="admin-sidebar__user-role">{user.role}</p>
          <form action={logoutAction}>
            <button type="submit" className="admin-sidebar__logout">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}
