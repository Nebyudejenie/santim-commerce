import type { MetadataRoute } from "next";

// Computed per-request, not frozen at build time: without this, Next.js
// prerenders robots.txt as a STATIC route using whatever process.env.APP_URL
// happened to be set to during `next build` — which can legitimately differ
// from the runtime value in a real deployment (build once, deploy to
// multiple environments), silently pointing the sitemap link at the wrong
// origin forever. Caught by an actual `curl` against a running server
// during verification, not by inspection — sitemap.ts already had this
// export for the same reason.
export const dynamic = "force-dynamic";

// Read directly from process.env, not the central env() validator: this file
// is evaluated at BUILD time for the static robots.txt route, and env()
// requires the full SantimPay schema (merchant id, private key, ...) to be
// set — which this project's own build process does not provide (next build
// succeeds today with only DATABASE_URL set). A raw fallback here is the
// correct, narrow exception, not a bypass of the "validate once, fail loud"
// principle env.ts exists for — that principle still governs every route
// that actually moves money or touches a payment credential.
const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Private, dynamic, or duplicate-content-prone paths — none of these
        // are pages a search engine should index or spend crawl budget on.
        disallow: [
          "/admin",
          "/account",
          "/sell",
          "/cart",
          "/checkout",
          "/api/",
          "/login",
          "/register",
        ],
      },
    ],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
