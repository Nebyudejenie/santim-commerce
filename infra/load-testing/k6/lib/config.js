// Shared config for every k6 script in this suite. One file, so a base URL
// change or a threshold policy change happens once, not per-script.

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3100";
export const METRICS_TOKEN = __ENV.METRICS_TOKEN || "";

// Applied per-scenario, not globally — a webhook burst and a browsing
// session have different acceptable latencies, and a single blanket
// threshold would either be too loose to catch a real regression on the
// fast paths or too strict to be achievable on the naturally slower ones.
export const THRESHOLDS = {
  fast: { p95: 300, p99: 800 }, // health/ready, order-status polling
  page: { p95: 1200, p99: 2500 }, // full SSR page renders (catalogue, PDP)
  webhook: { p95: 500, p99: 1500 }, // MUST stay under SantimPay's redelivery timeout — see docs §5.3
};
