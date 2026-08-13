/**
 * Environment configuration — validated once, at boot, then never re-read.
 *
 * WHY VALIDATE AT BOOT
 * --------------------
 * `process.env.SANTIMPAY_PRIVATE_KEY!` scattered through the codebase means a
 * missing secret is discovered by the first customer who tries to pay, at
 * 21:00, as a 500. Parsing the whole environment once at startup turns that
 * into a container that refuses to become ready — which your orchestrator
 * handles by keeping the previous, working version serving traffic.
 *
 * That is the entire idea behind readiness probes, and it only works if the
 * process is honest about being broken.
 */

import { z } from "zod";

const PEM_HINT =
  "Expected a PEM block starting with -----BEGIN. If your secret store holds it base64-encoded, decode it before injection, or set SANTIMPAY_PRIVATE_KEY_B64 instead.";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Which REAL-WORLD deployment this is — deliberately separate from
   * NODE_ENV. NODE_ENV controls Next.js's build/runtime optimizations and is
   * forced to "production" by `next start` regardless of what gets passed to
   * it; it says nothing about whether this instance is allowed to move real
   * money. A staging environment legitimately wants the optimized,
   * production-mode build (NODE_ENV=production) while intentionally pointing
   * at SantimPay's testbed — conflating the two would make that impossible,
   * which is exactly the bug this field exists to avoid.
   */
  DEPLOY_ENV: z.enum(["development", "staging", "production"]).default("development"),

  DATABASE_URL: z.string().url("DATABASE_URL must be a valid postgres:// URL"),

  /** Public origin, used to build absolute redirect and webhook URLs. */
  APP_URL: z.string().url(),

  // ---- SantimPay -----------------------------------------------------------
  SANTIMPAY_MERCHANT_ID: z.string().min(1),
  SANTIMPAY_PRIVATE_KEY: z.string().refine((v) => v.includes("-----BEGIN"), PEM_HINT),
  SANTIMPAY_ENVIRONMENT: z.enum(["testbed", "production"]),
  SANTIMPAY_GATEWAY_TOKEN: z.string().optional(),
  SANTIMPAY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /** Reject callbacks older than this many seconds. */
  WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),

  /** How long a checkout holds stock before the reservation expires. */
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(20),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  // Allow the key to arrive base64-encoded, which is how most secret managers
  // and CI systems prefer to carry multi-line values.
  const raw = { ...process.env } as Record<string, string | undefined>;
  if (!raw["SANTIMPAY_PRIVATE_KEY"] && raw["SANTIMPAY_PRIVATE_KEY_B64"]) {
    raw["SANTIMPAY_PRIVATE_KEY"] = Buffer.from(raw["SANTIMPAY_PRIVATE_KEY_B64"], "base64").toString("utf8");
  }

  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Crash loudly and specifically. A vague "cannot read property of
    // undefined" three layers deep costs an hour; this costs ten seconds.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // ---- Cross-field invariants that a per-field schema cannot express -------

  // The expensive mistake: real money, test credentials, or the reverse.
  if (env.SANTIMPAY_ENVIRONMENT === "production" && !env.SANTIMPAY_GATEWAY_TOKEN) {
    throw new Error(
      "SANTIMPAY_GATEWAY_TOKEN is required when SANTIMPAY_ENVIRONMENT=production (integration document p.5).",
    );
  }
  if (env.DEPLOY_ENV === "production" && env.SANTIMPAY_ENVIRONMENT === "testbed") {
    throw new Error(
      "Refusing to boot: DEPLOY_ENV=production with SANTIMPAY_ENVIRONMENT=testbed. " +
        "Customers would be shown a payment page that never moves real money.",
    );
  }
  if (env.DEPLOY_ENV !== "development" && !env.APP_URL.startsWith("https://")) {
    throw new Error(
      `APP_URL must be HTTPS in a deployed environment (DEPLOY_ENV=${env.DEPLOY_ENV}) — ` +
        "SantimPay will not call a plaintext notifyUrl.",
    );
  }

  return env;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= load();
  return cached;
}

/** Absolute URLs derived from APP_URL, so no route hardcodes the origin. */
export function urls() {
  const base = env().APP_URL.replace(/\/+$/, "");
  return {
    base,
    webhook: `${base}/api/webhooks/santimpay`,
    checkoutSuccess: (orderNumber: string) => `${base}/checkout/${orderNumber}/confirming`,
    checkoutFailed: (orderNumber: string) => `${base}/checkout/${orderNumber}/failed`,
    checkoutCancelled: (orderNumber: string) => `${base}/checkout/${orderNumber}/cancelled`,
  };
}
