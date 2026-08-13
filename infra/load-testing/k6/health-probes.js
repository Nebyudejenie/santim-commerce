/**
 * Kubernetes probe load — what the CLUSTER does to this app, independent of
 * any customer traffic at all.
 *
 * infra/k8s/base/deployment-web.yaml runs a livenessProbe every 15s and a
 * readinessProbe every 10s, PER POD. At the HPA's max of 12 replicas
 * (hpa-web.yaml), that's up to 12 concurrent liveness checks and 12
 * concurrent readiness checks landing on the fleet continuously, forever —
 * not a spike, a permanent background load the app must absorb without it
 * ever competing meaningfully with real traffic for connection-pool budget.
 *
 * /api/ready hits Postgres (see that route's module comment on why it's
 * allowed to, unlike /api/health) — this is the one place in the whole
 * suite that's specifically checking the DATABASE doesn't become the
 * bottleneck for something that isn't even customer-facing.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, THRESHOLDS } from "./lib/config.js";

const MAX_REPLICAS = 12;

export const options = {
  scenarios: {
    liveness: {
      executor: "constant-vus",
      vus: MAX_REPLICAS,
      duration: "60s",
      exec: "liveness",
    },
    readiness: {
      executor: "constant-vus",
      vus: MAX_REPLICAS,
      duration: "60s",
      exec: "readiness",
    },
  },
  thresholds: {
    "http_req_duration{route:health}": [`p(99)<${THRESHOLDS.fast.p99}`],
    "http_req_duration{route:ready}": [`p(99)<${THRESHOLDS.fast.p99}`],
    http_req_failed: ["rate==0"], // a failing probe restarts or de-routes a healthy pod — zero tolerance
  },
};

export function liveness() {
  const res = http.get(`${BASE_URL}/api/health`, { tags: { route: "health" } });
  check(res, { "health: 200": (r) => r.status === 200 });
  sleep(15); // matches livenessProbe.periodSeconds
}

export function readiness() {
  const res = http.get(`${BASE_URL}/api/ready`, { tags: { route: "ready" } });
  check(res, { "ready: 200": (r) => r.status === 200 });
  sleep(10); // matches readinessProbe.periodSeconds
}
