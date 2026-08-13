# Load testing

```
infra/load-testing/
├── k6/
│   ├── lib/config.js          shared BASE_URL + threshold policy
│   ├── smoke.js                1 VU, every route once — the CI gate
│   ├── browsing.js             ramping catalogue traffic, realistic funnel weights
│   ├── order-status-polling.js 100 concurrent "confirming payment" customers
│   ├── webhook-burst.js        SantimPay delivery spike, tight latency budget
│   └── health-probes.js        what the k8s cluster itself does to the app
└── fixtures/                   generated — see below, gitignored
    ├── order-numbers.json
    └── webhook-payloads.json
```

## Why checkout/cart mutations aren't driven from k6 directly

This is worth being honest about rather than papering over. Adding to cart and checking out are
**Server Actions bound through `useActionState`** — a real browser invokes them via a
JS-mediated `fetch` carrying a `Next-Action` header and an internally-encoded closure reference,
not a plain form POST. I found the action IDs in `.next/server/server-reference-manifest.json`
and tried replaying the wire protocol by hand; it returned an opaque `500 [Error: Connection
closed]`. That's the correct outcome to walk away from — reverse-engineering an internal,
version-fragile Next.js protocol to shave a small amount of "realism" off a load test is a bad
trade, and a load test built on a request shape that isn't actually what browsers send would be
worse than not having one.

Two things stand in for it, deliberately:

1. **The concurrency-critical logic is already proven where it matters most.**
   `apps/web/src/server/inventory/reservation.integration.test.ts` runs 200 genuinely concurrent
   `Promise.all` calls against a real Postgres instance and asserts exactly 1 succeeds against 1
   unit of stock. That's the actual mechanism preventing overselling — it doesn't need an HTTP
   layer wrapped around it to be a real test; it needs the real database, which it has.
2. **`order-status-polling.js` covers the traffic pattern that actually dominates checkout load.**
   Every customer whose payment hasn't resolved yet is polling, every 3 seconds, for minutes —
   that's a much larger and more sustained load than the single checkout POST itself.

If cart/checkout mutation load testing becomes a real requirement later, the correct tool is k6's
`k6/browser` module (real Chromium via CDP, executes actual client JS) — not a hand-built
imitation of Next's wire format.

## Running it

```bash
# 1. Download k6 (not installed by default): https://k6.io/docs/get-started/installation/

# 2. Generate fixtures (from apps/web/, against a running app + DB)
DATABASE_URL=postgresql://santim:santim@localhost:5432/santim_commerce pnpm run loadtest:seed-orders 200
pnpm run loadtest:seed-webhooks 500

# 3. Point at your running app (defaults to http://localhost:3100)
export BASE_URL=http://localhost:3100

# 4. Run whichever scenario
k6 run infra/load-testing/k6/smoke.js
k6 run infra/load-testing/k6/browsing.js
k6 run infra/load-testing/k6/order-status-polling.js
k6 run infra/load-testing/k6/webhook-burst.js       # regenerate fixtures immediately before this one
k6 run infra/load-testing/k6/health-probes.js
```

## Threshold policy (`k6/lib/config.js`)

| Tier | p95 | p99 | Applies to |
|---|---|---|---|
| `fast` | 300ms | 800ms | `/api/health`, `/api/ready`, order-status polling |
| `page` | 1200ms | 2500ms | Full SSR page renders (catalogue, PDP — real Prisma queries, no cache layer yet) |
| `webhook` | 500ms | 1500ms | The SantimPay callback — has a real redelivery deadline, not just a UX target |

These are starting thresholds, not laws of physics — tune them against your actual infrastructure
once you have a baseline run, and tighten them once caching (curriculum Phase 11) is in place.

## Cleaning up load-test data

Both fixtures scripts write real rows (`SC-LOADTESTxxxxxx` orders, `loadtest-*` webhook events).
Clean them up after a run against a shared environment:

```sql
DELETE FROM webhook_events WHERE "gatewayTxnId" LIKE 'loadtest-%';
DELETE FROM orders WHERE "orderNumber" LIKE 'SC-LOADTEST%';
```
