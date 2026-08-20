import type { NextConfig } from "next";

// A payment app is a phishing/clickjacking target by nature — SantimPay's
// hosted checkout page is loaded cross-origin, but nothing on THIS origin
// should ever be framed, and every response should carry the baseline OWASP
// header set. Applied to every route via the `source: "/:path*"` match.
const SECURITY_HEADERS = [
  // Blocks this app being iframed by another origin (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
  // Stops the browser guessing a response's MIME type from its content.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Never leak the full referring URL (which can contain order numbers,
  // session-adjacent paths) to a third-party destination.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No legitimate reason for this app to use the camera/mic/geolocation.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // HSTS is only meaningful once the app is actually served over HTTPS —
  // ingress.yaml's ssl-redirect already forces that in every real
  // environment. 2 years, includeSubDomains: the standard "ready to
  // preload" baseline.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // frame-ancestors 'none' is the modern, CSP-native replacement for
  // X-Frame-Options (kept both — X-Frame-Options still covers older
  // browsers CSP doesn't). form-action 'self' blocks this app's own forms
  // (login, checkout) from ever being repointed at an attacker's endpoint
  // by injected markup.
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  },
];

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  images: {
    // picsum.photos stands in for a real DAM/CDN in this project's seed data.
    // Swap for your actual asset host's pattern before shipping.
    remotePatterns: [{ protocol: "https", hostname: "picsum.photos" }],
    formats: ["image/avif", "image/webp"],
  },
  experimental: {
    // Server Actions are the primary mutation path (cart, checkout) — no
    // separate REST layer needed for those, which keeps the client bundle
    // smaller and removes a whole class of client/server drift.
    serverActions: { bodySizeLimit: "1mb" },
  },
  webpack: (webpackConfig) => {
    // Every relative import under src/server/** uses an explicit `.js`
    // extension pointing at a `.ts` file — required for the worker and seed
    // script, which run as plain Node ESM (`"type": "module"`) outside of
    // any bundler, where extensionless relative imports are not resolvable
    // at all. TypeScript's own "Bundler" moduleResolution understands that
    // `.js` convention and resolves it back to the `.ts` source (which is
    // why `tsc --noEmit` is clean), but webpack does not do this by default.
    // This alias teaches it the same rule, so the identical source files
    // build correctly under both runtimes without two copies of any import.
    webpackConfig.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return webpackConfig;
  },
};

export default config;
