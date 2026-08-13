/**
 * Webhook burst load test — SantimPay delivering a spike of payment
 * confirmations at once (a flash sale settling, or the gateway catching up
 * after its own brief outage and redelivering a backlog).
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * This endpoint has a hard deadline that has nothing to do with user
 * experience: SantimPay assumes failure and REDELIVERS if we don't
 * acknowledge fast (see the route's module comment and
 * docs/01-santimpay-protocol-spec.md §5.3). A slow response under load
 * doesn't just feel bad — it actively causes a redelivery storm, which is
 * how a brief slowdown turns into a much bigger incident. This test's
 * threshold is deliberately the tightest in the suite.
 *
 * Requires fixtures/webhook-payloads.json — generate it first:
 *   pnpm exec tsx scripts/generate-webhook-fixtures.ts 500
 * And regenerate it right before running (see that script's freshness note).
 */

import http from "k6/http";
import { check } from "k6";
import { BASE_URL, THRESHOLDS } from "./lib/config.js";

const fixtures = JSON.parse(open("../fixtures/webhook-payloads.json"));

export const options = {
  scenarios: {
    webhook_burst: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { duration: "10s", target: 20 }, // baseline delivery rate
        { duration: "10s", target: 100 }, // burst: settlement spike
        { duration: "10s", target: 100 },
        { duration: "10s", target: 5 }, // drain
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: [`p(95)<${THRESHOLDS.webhook.p95}`, `p(99)<${THRESHOLDS.webhook.p99}`],
  },
};

export default function () {
  // k6 initializes a separate JS VM per VU, so a plain module-scope counter
  // would start at 0 independently in EVERY VU — every VU's first request
  // would hit fixtures[0] simultaneously, not a spread across the pool.
  // __VU (1-indexed VU number) and __ITER (this VU's iteration count) are
  // k6 globals specifically for this: combining them gives each VU its own
  // walk through the pool, offset from every other VU's.
  const index = (__VU * 97 + __ITER) % fixtures.length;
  const fixture = fixtures[index];

  const res = http.post(`${BASE_URL}/api/webhooks/santimpay`, fixture.body, {
    headers: {
      "Content-Type": "application/json",
      "Signed-Token": fixture.signedToken,
    },
    tags: { route: "webhook" },
  });

  check(res, {
    // 200 (accepted/recorded) is success; 401 here would mean the fixture's
    // signature or freshness window expired mid-run — see this file's
    // module comment on regenerating fixtures before each run.
    "webhook: 200": (r) => r.status === 200,
    "webhook: acknowledged fast": (r) => r.timings.duration < THRESHOLDS.webhook.p99,
  });
}
