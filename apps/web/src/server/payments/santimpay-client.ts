/**
 * One configured SantimPay client for the whole process.
 *
 * Constructed lazily so that importing this module never crashes a build — the
 * secrets exist at runtime, not at `next build` time. Constructed ONCE so we
 * do not re-parse the PEM on every checkout.
 */

import { SantimPayClient } from "@santim/santimpay";
import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";

let client: SantimPayClient | undefined;

export function santimpay(): SantimPayClient {
  if (client) return client;

  const cfg = env();
  client = new SantimPayClient({
    merchantId: cfg.SANTIMPAY_MERCHANT_ID,
    privateKey: cfg.SANTIMPAY_PRIVATE_KEY,
    environment: cfg.SANTIMPAY_ENVIRONMENT,
    gatewayToken: cfg.SANTIMPAY_GATEWAY_TOKEN,
    timeoutMs: cfg.SANTIMPAY_TIMEOUT_MS,
    onRetry: ({ attempt, delayMs, error }) => {
      // Retries are normal; a SPIKE in retries is the early warning that the
      // gateway is degrading. Emit it as a countable event, not a silent sleep.
      logger.warn("santimpay.retry", {
        attempt,
        delayMs,
        error: error.message,
      });
    },
  });

  return client;
}
