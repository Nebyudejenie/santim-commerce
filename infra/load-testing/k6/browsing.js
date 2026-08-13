/**
 * Storefront browsing load test.
 *
 * WHY THIS SHAPE OF TEST MATTERS MOST
 * ------------------------------------
 * For a real store, browse:purchase ratios of 50:1 to 200:1 are normal —
 * most load on a storefront is people looking, not paying. This test
 * simulates that funnel directly: home → shop → a product detail page,
 * weighted so PDP views (the heaviest single-page query — catalogue join +
 * variant + inventory + images) happen as often as they realistically would,
 * not once per iteration regardless of the rest of the funnel.
 *
 * Every page here is a Server Component doing a real Prisma query against
 * Postgres on every request (see catalogue-service.ts — no caching layer
 * yet, deliberately: Phase 11 in the curriculum is exactly "add caching
 * once you've measured you need it," and this test is the measurement).
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, THRESHOLDS } from "./lib/config.js";

export const options = {
  scenarios: {
    browsing: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 20 }, // ramp up
        { duration: "40s", target: 20 }, // hold — the number that matters
        { duration: "20s", target: 50 }, // spike — a promo/social-share moment
        { duration: "20s", target: 50 },
        { duration: "20s", target: 0 }, // ramp down
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], // <1% errors even under the spike
    "http_req_duration{route:home}": [`p(95)<${THRESHOLDS.page.p95}`],
    "http_req_duration{route:shop}": [`p(95)<${THRESHOLDS.page.p95}`],
    "http_req_duration{route:pdp}": [`p(95)<${THRESHOLDS.page.p95}`],
  },
};

const PRODUCT_SLUGS = [
  "aria-overshirt", "meridian-parka", "essential-tee", "field-trouser",
  "runner-low", "desert-chukka", "harbor-knit", "canvas-tote",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  // Every session starts at the homepage.
  const home = http.get(`${BASE_URL}/`, { tags: { route: "home" } });
  check(home, { "home: 200": (r) => r.status === 200 });
  sleep(randomThinkTime());

  // ~70% continue to the catalogue; the rest bounce (realistic drop-off).
  if (Math.random() < 0.7) {
    const shop = http.get(`${BASE_URL}/shop`, { tags: { route: "shop" } });
    check(shop, { "shop: 200": (r) => r.status === 200 });
    sleep(randomThinkTime());

    // ~50% of those who browse the catalogue click into a product.
    if (Math.random() < 0.5) {
      const slug = pick(PRODUCT_SLUGS);
      const pdp = http.get(`${BASE_URL}/products/${slug}`, { tags: { route: "pdp" } });
      check(pdp, {
        "pdp: 200": (r) => r.status === 200,
        "pdp: real product rendered": (r) => r.body.includes("pdp__title") || r.status !== 200,
      });
      sleep(randomThinkTime());
    }
  }
}

function randomThinkTime() {
  return 1 + Math.random() * 3; // 1-4s, a human reading a page
}
