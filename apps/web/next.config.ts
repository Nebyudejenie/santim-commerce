import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
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
