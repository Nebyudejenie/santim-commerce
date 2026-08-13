/**
 * Order-status polling load test.
 *
 * This is the scenario that most directly maps to "checkout traffic" without
 * needing a browser to drive a Server Action (see this suite's README for
 * why cart/checkout mutations aren't driven from k6 directly). Every
 * customer whose payment hasn't resolved yet is sitting on the confirming
 * page polling `/api/orders/:orderNumber/status` every 3 seconds — see
 * `OrderConfirmation`'s POLL_INTERVAL_MS. A traffic spike after a marketing
 * push means a spike in CONCURRENT POLLERS, not just concurrent checkouts,
 * and that's exactly what this test reproduces.
 *
 * Requires fixtures/order-numbers.json — generate it first:
 *   pnpm exec tsx infra/load-testing/fixtures/seed-load-test-orders.ts 200
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, THRESHOLDS } from "./lib/config.js";

const orderNumbers = JSON.parse(open("../fixtures/order-numbers.json"));

export const options = {
  scenarios: {
    polling: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 100 }, // 100 concurrent "confirming payment" customers
        { duration: "45s", target: 100 },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"], // this endpoint has no excuse to fail
    http_req_duration: [`p(95)<${THRESHOLDS.fast.p95}`, `p(99)<${THRESHOLDS.fast.p99}`],
  },
};

export default function () {
  // Each VU is one customer, polling the SAME order repeatedly for the
  // duration of their session — not a new random order every request,
  // which would understate how hot a single row gets during a real spike.
  const orderNumber = orderNumbers[Math.floor(Math.random() * orderNumbers.length)];

  for (let i = 0; i < 6; i++) {
    const res = http.get(`${BASE_URL}/api/orders/${orderNumber}/status`, {
      tags: { route: "order_status" },
    });
    check(res, {
      "status: 200": (r) => r.status === 200,
      "status: valid JSON body": (r) => {
        try {
          const body = JSON.parse(r.body);
          return typeof body.status === "string" && typeof body.totalSantim === "number";
        } catch {
          return false;
        }
      },
    });
    sleep(3); // matches the real client's POLL_INTERVAL_MS
  }
}
