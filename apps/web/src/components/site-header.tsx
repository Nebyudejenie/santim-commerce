import Link from "next/link";
import { getCartItemCount } from "@/server/cart/get-cart-summary";
import { getSessionUser } from "@/server/auth/session";
import { getUnreadCount } from "@/server/notifications/notification-service";
import { SearchBar } from "./search-bar";

export async function SiteHeader() {
  const [count, user] = await Promise.all([getCartItemCount(), getSessionUser()]);
  const unreadNotifications = user ? await getUnreadCount(user.id) : 0;

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href="/" className="site-header__mark" aria-label="LUMEN home">
          LUMEN
        </Link>

        <nav className="site-header__nav" aria-label="Primary">
          <Link href="/shop">Shop</Link>
          <Link href="/collections/new-arrivals">New Arrivals</Link>
          <Link href="/collections/outerwear">Outerwear</Link>
          <Link href="/collections/footwear">Footwear</Link>
        </nav>

        <div className="site-header__actions">
          <SearchBar />

          {user && (
            <Link href="/account/notifications" className="site-header__cart" aria-label={`Notifications${unreadNotifications > 0 ? `, ${unreadNotifications} unread` : ""}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M18 16v-5a6 6 0 1 0-12 0v5l-1.5 2.5h15L18 16Z"
                  stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
                />
                <path d="M9.5 20a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {unreadNotifications > 0 && <span className="site-header__cart-badge">{unreadNotifications}</span>}
            </Link>
          )}

          <Link href={user ? "/account" : "/login"} className="site-header__account" aria-label={user ? "Your account" : "Sign in"}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M4.5 20c1.5-4 4.5-6 7.5-6s6 2 7.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </Link>

          <Link href="/cart" className="site-header__cart" aria-label={`Bag, ${count} item${count === 1 ? "" : "s"}`}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z"
                stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
              />
              <path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            {count > 0 && <span className="site-header__cart-badge">{count}</span>}
          </Link>
        </div>
      </div>
    </header>
  );
}
