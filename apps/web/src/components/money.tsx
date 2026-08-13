// Deliberately `@santim/santimpay/money`, NOT the package root. This
// component is used from client components (e.g. AddToCartForm), and the
// root barrel re-exports crypto.ts (`node:crypto`, `jsonwebtoken`) alongside
// the pure formatting helpers. Importing the root here once bundled the
// entire payment-signing module graph into client-side JavaScript — a
// production bundle shipping ES256 signing code to the browser. The `/money`
// subpath exports only the dependency-free arithmetic in money.ts, so
// webpack has nothing server-only to pull in.
import { format, type Santim } from "@santim/santimpay/money";

/** Consistent ETB rendering everywhere a price appears. */
export function Money({ santim, className }: { santim: number; className?: string }) {
  return <span className={className}>{format(santim as Santim)}</span>;
}
