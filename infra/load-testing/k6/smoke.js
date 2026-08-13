/**
 * Smoke test — the one that runs in CI before anything heavier.
 *
 * 1 virtual user, a handful of iterations, every documented public route hit
 * once. The question this answers is not "how much load can we take" but
 * "did the last deploy break something basic" — and it should run in under
 * 30 seconds so nobody skips it.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "./lib/config.js";

export const options = {
  vus: 1,
  iterations: 5,
  thresholds: {
    http_req_failed: ["rate==0"], // zero tolerance — this is the smoke test
    http_req_duration: ["p(95)<2000"],
  },
};

const ROUTES = [
  "/",
  "/shop",
  "/collections/new-arrivals",
  "/products/aria-overshirt",
  "/cart",
  "/login",
  "/register",
  "/api/health",
];

export default function () {
  for (const route of ROUTES) {
    const res = http.get(`${BASE_URL}${route}`);
    check(res, {
      [`${route} responds 200`]: (r) => r.status === 200,
    });
  }
  sleep(1);
}
