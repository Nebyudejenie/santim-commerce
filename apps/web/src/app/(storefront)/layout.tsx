import type { Metadata, Viewport } from "next";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";
import "./components.css";

// Swap in `next/font/google` (Fraunces + Inter) or self-hosted `next/font/local`
// files the moment this deploys somewhere with egress to Google Fonts — the
// build environment this was authored in has none. Until then, globals.css's
// --font-display / --font-body tokens already carry a full system-font
// fallback stack (Georgia / system-ui), so the layout degrades gracefully
// rather than failing to build.

// Read directly from process.env, not the central env() validator — see
// app/robots.ts's own comment on why: this evaluates at build time, before
// this project's build process guarantees the full SantimPay env schema.
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: "LUMEN — Minimal essentials", template: "%s — LUMEN" },
  description: "Minimal apparel and footwear, built for Addis and beyond. Pay with Telebirr, CBE Birr, or Amole.",
  openGraph: {
    siteName: "LUMEN",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#14130f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
