import type { Metadata, Viewport } from "next";
// This IS a root layout — see the module doc below — so it owns <html>/<body>
// and pulls the design TOKENS (colors, spacing, type scale) from the
// storefront route group directly. It deliberately does NOT import that
// group's components.css: admin has its own component styles (admin.css)
// and no reason to ship product-card/hero/checkout CSS into the admin bundle.
import "../(storefront)/globals.css";
import "./admin.css";

/**
 * `/admin` is its OWN root layout, in its own route group-less top-level
 * segment, sitting beside `(storefront)`'s root layout. Two independent
 * roots is intentional: nesting this under the storefront's layout would
 * wrap every admin page in the customer-facing header, cart badge, and
 * footer — chrome that makes no sense for an internal tool.
 *
 * DELIBERATELY BARE: no sidebar, no auth check. Both live in
 * `(dashboard)/layout.tsx`, a NESTED layout that wraps every admin route
 * except `/admin/login`. Putting the auth check here instead would either
 * gate the login page itself (infinite redirect) or need special-casing
 * around it — nesting is what lets "protected" be the default for
 * everything except the one route that must stay reachable while logged out.
 */
export const metadata: Metadata = {
  title: { default: "Admin", template: "%s — LUMEN Admin" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#14130f" },
  ],
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
