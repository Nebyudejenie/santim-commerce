# Project Execution State

Persistent engineering log for santim-commerce. This file is the resume
point if execution is interrupted: read this file, check `git log --oneline
-20` and `git status`, and continue from NEXT ACTION.

Last updated: 2026-08-20, commit `1864141` on `main` (pushed; CI in flight
at time of writing — confirm with `gh run list --branch main --limit 1`).

## MANDATE: MULTI-VENDOR MARKETPLACE TRANSFORMATION (current, active)

As of commit `1864141`, the mandate expanded from "harden the existing
single-vendor payment-integration app for production" (mostly complete —
see PRODUCTION-READINESS HISTORY below) to "transform this into a
full-featured multi-vendor marketplace comparable in functional depth to a
mature platform like eBay" — multi-vendor selling, seller
verification/reputation, order splitting and per-seller fulfillment,
commission/settlement, returns/refunds/disputes, richer search, reviews,
promotions/coupons, buyer-seller messaging, and the admin/observability
surface to run all of it.

This is genuinely large — realistically many sessions of real engineering,
not something to fake-complete in one pass (the mandate itself is explicit
about this: no placeholder workflows, no dead UI, no mock business logic).
Working through it in dependency order, each slice fully tested and pushed
before starting the next, tracked here so it survives a context reset.

### Roadmap (dependency order — do not skip ahead of an unchecked item
without a specific reason, since almost everything below depends on the
seller domain existing first)

- [x] **Seller domain foundation** (`1864141`) — `Seller` model with a
      PENDING/APPROVED/SUSPENDED/REJECTED lifecycle; `Product.sellerId` and
      `OrderLine.sellerId` (snapshotted); `Variant.sku` rescoped to
      unique-per-product (was globally unique — broke the "two sellers, same
      SKU" case a real marketplace needs). Seller apply flow (`/sell`) and
      admin review queue (`/admin/sellers`). Real hand-written
      expand-backfill-contract migration (8 existing seed products
      backfilled onto a placeholder "Legacy Catalogue" seller, zero data
      loss, zero schema drift afterward). Found and fixed an independent,
      real security gap while building this: no Server Action anywhere in
      the codebase checked its own authorization (all relied solely on the
      page/layout rendering their trigger form, which Next.js's own
      security guidance says is insufficient — Server Actions are
      independently-invokable endpoints). Fixed the pre-existing
      `resettlePaymentAction` the same way the new seller actions were
      built from the start. 8 new tests (6 integration, 2 unit), all
      passing; 7/7 real HTTP checks against a live server for the full
      apply→PENDING→approve→APPROVED flow, including page-level
      authorization (unauthenticated, non-staff).
- [x] **Seller listing management** (`7dd3210`) — `listing-service.ts`:
      createProduct (DRAFT + first variant + real inventory, one
      transaction), updateProduct, setProductStatus (DRAFT→ACTIVE→ARCHIVED
      →ACTIVE, publish requires ≥1 variant), addVariant, updateVariant.
      Every function's authorization: returns null / throws exactly as if
      the resource didn't exist for a non-owning seller (never
      forbidden-vs-not-found). UI: `/sell/products` (list),
      `/sell/products/new`, `/sell/products/[id]` (edit + publish +
      variant table). Images are URL-entry only (no upload pipeline built
      — a deliberate, documented v1 simplification, see NEXT ACTION).
      6 new integration tests including the adversarial cross-seller case
      (a seller cannot edit/publish/add-variant-to another seller's
      listing, verified against a real DB with zero side effects from the
      rejected calls). 7/7 real HTTP checks: create→still-invisible-as-
      DRAFT→cross-seller-404→publish→now-visible-on-PDP-and-shop.
- [x] **Buyer-facing seller visibility** (`5602fbb`) — "Sold by {store}"
      on the PDP, linking to a new public `/sellers/[slug]` storefront
      (APPROVED sellers only, their real ACTIVE products). Building this
      surfaced a real gap it then fixed: catalogue/cart/checkout only
      checked `product.status === ACTIVE`, never `seller.status ===
      APPROVED` — a suspended seller's listings would have stayed fully
      browsable, addable-to-cart, and purchasable (the mandate's own
      "seller becomes unavailable" edge case, section 5/19). Fixed at all
      three layers: browse (`VISIBLE_PRODUCT_WHERE`), add-to-cart
      (`addLine`), and checkout (`placeOrder`'s existing price-recheck
      pattern, extended). `checkout-service.ts` had ZERO dedicated tests
      before this — added a real integration test for the new gate
      specifically (full happy-path-through-real-payment was deliberately
      not attempted — no gateway mock exists in this suite, and a real
      outbound call with fake credentials doesn't belong in a test; see
      the test file's own comment). 8/8 real HTTP checks including a
      full pre/post-suspension visibility sweep across PDP, storefront,
      and shop listing.
- [~] **Order splitting / seller fulfillment** — read side done
      (`listSellerOrderLines`/`getSellerOrderDetail` in
      `seller-order-queries.ts`, `/sell/orders` + `/sell/orders/
      [orderNumber]`; only PAID/REFUNDED/PARTIALLY_REFUNDED orders shown —
      a seller finding out before payment clears is a false signal, not
      useful information; verified via real ownership-isolation tests, a
      seller cannot see another seller's order even with the real
      orderNumber). Still missing: per-seller fulfillment STATUS —
      `Order.fulfilmentStatus` is one field on the whole Order, which is
      wrong for a genuinely multi-seller order (seller A can ship their
      item while seller B hasn't; today there's no way to represent that).
      Needs either an `OrderLine.fulfilmentStatus` field or a proper
      `Fulfillment`/shipment-per-seller model — a real schema decision, not
      done yet. Payment collection stays single-PaymentIntent-per-Order
      (deliberate — see the seller-domain commit's own comment); this
      remains purely a fulfillment/reporting split, not a payment split.
      **Also found and fixed a severe, unrelated bug while building this**:
      building the sold-order detail page (which renders product images)
      surfaced that `next/image`'s `remotePatterns` allowlist only ever
      covered `picsum.photos` — meaning ANY product with a seller-supplied
      image from a different host (which `listing-service.ts`'s own
      "paste a link you already host" feature explicitly invites) 500'd
      the ENTIRE page, not just the image, for every visitor. Confirmed for
      real (created a product with a `example.com` image URL, hit its PDP,
      got a real 500 with Next's own `next-image-unconfigured-host`
      error). Fixed properly, not by loosening the allowlist (arbitrary
      remote hosts through next/image's own proxy is a real SSRF/cost-
      abuse surface): a new shared `<ProductImage>` component using a
      plain `<img>` for every seller-controlled image site (PDP gallery,
      ProductCard, cart lines, account order detail, seller sold-order
      detail — 5 sites) — admin/seed-controlled images (home page hero,
      collection tiles) were confirmed NOT seller-editable and correctly
      left on `next/image`. Re-verified the exact same previously-500ing
      product now returns 200 with a real `<img>` tag in the response.
- [x] **Commission & settlement ledger** (`b5b5706`) — `SellerLedgerEntry`:
      append-only SALE/COMMISSION/REFUND/ADJUSTMENT rows, balance always
      computed fresh from real history (`SUM WHERE settledAt IS NULL`),
      never a mutable running total. Wired into the ALREADY-EXISTING
      outbox pattern (worker's `deliver()` was an explicitly documented
      placeholder for the "order.paid" topic — not a new mechanism).
      Idempotent under real at-least-once outbox redelivery via a database
      unique constraint (`@@unique([orderLineId, type])`), verified by
      calling the settlement function 3× for the same order and confirming
      exactly one SALE + one COMMISSION entry, not three. Verified a
      multi-seller order settles each seller's own commission rate
      independently (5%/20% sellers never leak into each other's ledger).
      `/sell/earnings` page, re-verified end-to-end over real HTTP.
      **Deliberately NOT built**: actual money movement (a real SantimPay
      B2C payout to pay a seller out) — `docs/01-santimpay-protocol-
      spec.md`'s own §8 open-questions list flags refund/payout semantics
      against the real gateway as unconfirmed with SantimPay ops.
      Fabricating a specific real-money gateway call sequence against
      unconfirmed API semantics is a different risk category than a normal
      engineering judgment call; `settledAt` exists on the schema so this
      doesn't need another migration when that capability is built with
      real confirmation. This is also why **returns/refunds** (next item)
      is scoped to the workflow/data side only, not the money-movement
      side, for the same reason.
- [x] **Reviews & ratings** (`f94ffbd`) — `ProductReview`/`ReviewReport`.
      Verified purchase is an ENFORCED precondition (a real order line
      required, not a cosmetic badge) — the exact same
      `findEligibleOrderLine` function gates both the write path and the
      UI's decision to show the form, so they can never drift. One review
      per (product, user) via a real DB constraint. No separate
      SellerReview model — a seller's rating is the average across their
      own products' reviews (real marketplaces mostly work this way at the
      foundation). Moderation queue (`/admin/reviews`), seller responses
      (ownership-checked), reporting (one report per user per review, also
      a real constraint). 7 new tests including the core adversarial case
      (a user who never bought the product cannot review it — verified
      zero rows created) and HIDDEN-reviews-excluded-from-aggregation.
      Verified end-to-end over real HTTP: a real buyer with a real PAID
      order sees the write-a-review form, a non-buyer doesn't, and a
      submitted review appears on the real PDP with the correct
      5.0/1-review aggregate.
- [ ] **Returns, refunds, disputes** — `OrderStatus` already has
      REFUNDED/PARTIALLY_REFUNDED; no actual return-request workflow,
      approval, or dispute resolution exists yet.
- [ ] **Coupons & promotions** — nothing exists yet.
- [ ] **Search depth** — current search is catalogue browsing only (no
      keyword search implementation was found in Phase 2's earlier audit
      of this codebase); real marketplace search (filtering, sorting,
      ranking) is unbuilt.
- [ ] **Seller reputation metrics** — order completion/cancellation/return
      rates, response time — needs order and review data flowing first.
- [ ] **Admin marketplace controls** — extend the existing admin surface
      (orders, reconciliation, now sellers) to cover the above as they're
      built: dispute resolution, commission config, promotion management.

### Working discipline for this mandate (carried over from what already
proved out this session — do not relax these just because the scope grew)

- Every schema change that touches a table with real rows gets a
  hand-written expand-backfill-contract migration, verified for zero drift
  afterward (`prisma migrate dev` reporting "already in sync"), not a bare
  `prisma migrate dev` against non-empty tables.
- Every new Server Action checks its own authorization — never rely on the
  page/layout that renders its trigger form.
- Every new feature gets real tests (unit for pure logic, integration
  against real Postgres for anything DB-backed) AND, where practical, a
  real HTTP end-to-end check against a live server — not just "the code
  looks right."
- Full regression suite (`pnpm -r typecheck && pnpm -r lint &&
  pnpm --filter @santim/santimpay test && pnpm --filter @santim/web
  test:unit && pnpm --filter @santim/web test:integration`) before every
  commit, real CI watched to a genuinely uncontested completion before the
  next push (this session already got burned once by pushing too fast and
  triggering the concurrency-group's `cancel-in-progress` — see
  PRODUCTION-READINESS HISTORY below).
- State machines for anything with a lifecycle live in their own pure,
  zero-import module (see `seller-state-machine.ts` following
  `orders/state-machine.ts`'s precedent) — required for `test:unit`
  (plain `node --experimental-strip-types`) to even run them, and it's
  also just better-tested code.

## PRODUCTION-READINESS HISTORY (prior mandate, mostly complete)

Everything below this line documents the earlier "harden the existing
single-vendor app for production" effort. It is not obsolete — the CI/CD
pipeline, security headers, Docker hardening, chaos/load-test evidence,
and payment-correctness work it describes all still apply directly to the
marketplace transformation above (a marketplace still needs correct
payments, security headers, and a working CI pipeline) — but new work
should be tracked in the ROADMAP above, not appended here.

## CURRENT PHASE (historical — see MANDATE above for active work)

Phase 1 (Repository Sync) — complete. Phase 2 (Repository Audit) — complete,
two full passes (application-layer: dead code, payments, inventory,
authorization, secrets; infra-layer: DB schema, migrations, security headers,
rate limiting, container security, K8s manifests, Trivy ignore quality).
Phase 4 sub-slice (customer order visibility) — fixed. Phase 9 (Database
Integrity) — fixed (FK guardrails, missing indexes). Phase 11 (Security
Audit) sub-slices — fixed (response security headers, edge rate limiting,
container hardening). Phase 13 (Chaos Testing) — one real drill executed
with fresh evidence (checkout transaction atomicity under a killed DB
connection). Phase 14 (Observability) — dashboard-vs-metrics drift check
done, no drift found. Phase 15 (Performance) — 3 real k6 load tests
executed against a real production build (smoke, ramping browsing spike to
50 VUs, sustained 12-replica health-probe load) — see LOAD TEST RESULTS
below; one real, reproduced 503 finding turned out to be my own test-setup
error (missing env var), not an app bug, confirmed and documented as such.
Phase 16 (Docker) — fixed (dev-dependency pruning, HEALTHCHECK) and
validated with a real CI Docker build + Trivy scan. Phase 18 (CI/CD)
sub-slice (lint) — fixed. Phase 20 (Documentation) — root README added.
Phases 3, 5–8, 10, 12, 17, 19, 21 — not freshly re-walked this pass; see
NEXT ACTION.

## CURRENT GATE

All work through the items below is committed, pushed, and CI-confirmed
green on `origin/main`. Ready to continue into the remaining unwalked
phases, or to produce the final structured report if the remaining scope
is being deliberately deferred — see PRODUCTION READINESS STATUS.

## COMPLETED GATES (this execution pass, chronological)

1. Repo sync to `origin/main`, Dependabot PRs #1–8, #11–13 merged (9 total
   this pass), each verified via real passing CI before merge. PRs #9
   (Prisma 7), #10 (Next.js 16), #14 (TypeScript 7) left open by design —
   each a real, reproduced breaking migration, not a safe bump.
2. Real CVE fixed: `CVE-2026-40345` (deepmerge-ts), `e3652bb`.
3. Real test-flakiness bug fixed: order-number truncation, `3c0d597`.
4. `test:integration` fixed (`node --experimental-strip-types` → `tsx`),
   part of `b3498fe`.
5. Full Phase-2 application-layer audit (dead code, payments, inventory
   concurrency, authorization, secrets, test inventory) — all clean except
   one real gap found and fixed:
6. **`2408472`** — customer order-detail page (`/account/orders/[orderNumber]`),
   wiring up a previously-orphaned, correctly-scoped `getOrderForUser`.
   Verified via 5 real HTTP checks against a live session-backed dev
   server (golden path, cross-user 404, unauth redirect, nonexistent 404).
7. **`cbf2db4`** — lint gap closed. CI's own comment claimed "typecheck/lint"
   but no lint existed anywhere. Added real ESLint to both packages, fixed
   6 real pre-existing lint errors it surfaced.
8. **`15e55ca`** — this file's first version.
9. **`0fd48fd`** — `docs/release/PRODUCTION-RELEASE.md` created (self-corrected
   one wrong claim about a missing Grafana dashboard before shipping it —
   the dashboard is real and does track business-health metrics).
10. **`d05f771`** — security(web,k8s): a dedicated infra audit found ZERO of
    the standard OWASP security headers set anywhere, and no rate limiting
    at any layer despite app code assuming it exists at the edge. Added
    all 6 headers via `next.config.ts`, verified live on real HTTP
    responses. Split `ingress.yaml` into two Ingress resources so a real
    per-IP rate limit (20rps/burst5x) applies to everything except the
    SantimPay webhook path (deliberately exempt — signature verification
    is the real trust authority there). Caught and fixed a real bug in the
    first draft (paths were backwards) by actually rendering the overlay
    and inspecting it, not by assuming the edit was correct. Re-validated
    both overlays with kubeconform -strict: 17/17.
11. **`15ed895`** — fix(db): the same infra audit found all 4 of Order's
    Cascade children (OrderLine, OrderEvent, PaymentIntent, ShippingLabel)
    would be silently destroyed if an Order were ever hard-deleted — no
    code path does this today, but there was no guardrail either. Switched
    to Restrict (metadata-only, zero current-behavior change). Added 3
    indexes for real, confirmed query patterns that had none
    (orders(status,paidAt), payment_intents(status,createdAt),
    inventory_reservations(orderId,status)). Caught a real, direct
    consequence while re-running the suite: a test's own cleanup hook
    deleted Order before its ShippingLabel child, which Restrict now
    correctly refuses — fixed the cleanup ordering, not the constraint.
12. **`8539b5d`** — security(docker): same audit found no HEALTHCHECK and
    devDependencies (eslint, typescript, ~60MB) shipping in the production
    image. Fixing this correctly required first reclassifying `prisma`
    (the CLI) from dev to a real dependency — it's needed at runtime by
    the migrate role, which shares this image. Verified the actual prune
    command OUTSIDE Docker first (this sandbox's Docker daemon has no
    network egress): discovered `pnpm install --prod` alone does NOT
    shrink anything (only removes symlinks, leaves real bytes in
    `node_modules/.pnpm`) — `pnpm prune --prod` is the command that
    actually does. Booted the real production server against the pruned
    tree and got a real 200 with all security headers intact before
    trusting it in the Dockerfile. Then this exact Dockerfile was
    validated for real by CI's Docker build + Trivy scan job, which has
    genuine network access — both passed.
13. **`a31a199`** — docs: added the repository root README (a real, total
    gap — none existed).
14. **Real chaos drill executed** (not yet committed as new code — the
    drill script already existed, this pass just ran it): `pnpm run
    chaos:checkout-atomicity` against the real local Postgres, genuinely
    killing a backend connection mid-transaction during checkout. Result:
    **PASS** — `placeOrder()` correctly rejected, cart stayed ACTIVE, zero
    orders created, inventory reservation counts unchanged, zero orphaned
    reservations. One leftover test cart from an earlier misconfigured
    (missing env vars) attempt was found and cleaned from the dev
    database — not an app bug, an artifact of my own first invocation
    crashing before its own cleanup ran.
15. **Real k6 load tests executed** (k6 v2.2.0 downloaded fresh — not
    installed by default, per `infra/load-testing/README.md`) against a
    real `next build`/`next start` production server on port 3100, not
    `next dev`:
    - **`smoke.js`**: PASS. 40 requests across all 8 documented public
      routes, 0% failures, p95=96.43ms (threshold 2000ms).
    - **`browsing.js`**: PASS. Ramping scenario to 50 concurrent VUs
      (realistic browse funnel: home→shop→PDP with think-time and
      drop-off), 1321 real HTTP requests each hitting a real Prisma/
      Postgres query (no caching layer, by design — see the script's own
      comment), 0% failures, p95 112–128ms across all three route tiers
      against a 1200ms threshold (~9x headroom).
    - **`health-probes.js`**: first run genuinely FAILED —
      `http_req_failed rate=60%`, all 72 `/api/ready` requests returned
      503. Investigated instead of dismissed: `curl -v` showed
      `{"ready":false,"checks":{"config":"fail","database":"ok"}}`, and
      the server's own structured log showed exactly why:
      `SANTIMPAY_ENVIRONMENT: Invalid input` — I had started this
      particular server instance without setting that env var. This is
      the app's readiness check working *correctly* (refusing to report
      ready with invalid config, exactly the intended fail-safe
      behavior), not a bug. Restarted with the complete env var set,
      re-ran: PASS, 120/120 requests (12 simulated liveness + 12
      simulated readiness probes/replica, sustained 60s, matching the
      HPA's real max of 12 replicas), 0% failures, p99 279–314ms against
      an 800ms threshold. `/api/ready`'s real `SELECT 1` Postgres query
      held up fine under sustained concurrent load.
    - **`order-status-polling.js`**: PASS. Generated real fixture data first
      (`loadtest:seed-orders 200` — 200 disposable `SC-LOADTEST######`
      orders in a realistic status mix). Ramping to 100 concurrent
      "confirming payment" pollers, each hitting the same order repeatedly
      every 3s (matching the real client's actual poll interval) — 2162
      requests, 0% failures, p95=25.92ms/p99=44.87ms against 300ms/800ms
      thresholds. All 200 test orders and the fixture file deleted
      afterward — psql confirmed `DELETE 200`, nothing left behind.

## AUDIT FINDINGS — full detail

### Application-layer audit (dead code, payments, inventory, authz, secrets)
- **Dead code**: clean except one gap, fixed (see #6 above).
- **Payments**: webhook signature verification confirmed to actually
  *reject* tampered/wrong-key/stale callbacks (not just run) — see
  `packages/santimpay/test/webhook.test.ts`. Idempotency key generated
  once, persisted before the gateway call — `payment-service.ts:89`. Money
  is integer-only via a branded `Santim` type — `money.ts`.
- **Inventory concurrency**: real atomic conditional `UPDATE`, not
  check-then-write — `reservation.ts:87-92`. 8/8 integration tests pass
  (200-concurrent/1-unit and 50-concurrent/10-unit cases included).
- **Authorization**: admin gated server-side in a layout; customer order
  access scoped by session-derived `userId`, never client input. One
  deliberate, documented unauthenticated route (order status polling,
  returns no PII).
- **Secrets**: `.env.example` placeholders only, no hardcoded secrets in
  tracked source.

### Infra-layer audit (DB schema, migrations, security headers, rate
limiting, container, K8s manifests, Trivy ignore)
- **DB schema**: all 19 FKs had explicit onDelete (none relying on an
  implicit default); 4 Cascade-on-Order children identified as a latent
  risk and fixed (#11 above). Several real missing-index gaps found and
  fixed for orders/payment_intents/inventory_reservations (#11). One
  smaller, NOT yet fixed: `admin-queries.ts`'s orderNumber/email search
  uses a leading-wildcard `ILIKE '%term%'`, which no B-tree index can
  serve — would need `pg_trgm`/GIN. Admin-only feature, not payment/
  customer-critical — logged as P3, not fixed this pass.
- **Migrations**: all 4 (3 original + the new indexes/FK one) confirmed
  purely additive — no `DROP COLUMN`/`DROP TABLE`/destructive `ALTER`.
- **Security headers & rate limiting**: was a complete gap, now fixed
  (#10 above). The CSP added is intentionally conservative
  (`frame-ancestors`, `base-uri`, `form-action` only — no `script-src`
  lockdown) to avoid breaking the app without more extensive testing than
  this pass could safely verify; a fuller CSP is a real follow-up, not
  done here. Login/register still have no *application-level* brute-force
  lockout (only the edge-level rate limit now) — investigated
  `auth-actions.ts` directly, confirmed no attempt-counting exists; not
  implemented this pass (a stateful lockout needs careful design to avoid
  becoming its own DoS vector — a bigger, separate decision, not a quick
  fix). Logged as P2, not fixed.
- **Container security**: non-root confirmed pre-existing; base image
  pinned to a tag not a digest (P3, debatable tradeoff, not changed); dev
  deps shipping in the image and no HEALTHCHECK — both fixed (#12).
- **K8s manifests**: securityContext, resource requests, probes,
  networkpolicy (real default-deny, not a no-op), no hardcoded secrets —
  all confirmed clean, nothing to fix.
- **Trivy ignore file**: confirmed high-quality, dated, reasoned
  justifications for all 8 entries — nothing to fix.

## ACTIVE WORK

None in flight. All commits through `a31a199` are pushed and CI-confirmed
green (including the real Docker build + Trivy scan).

## P0 (critical — security / data-integrity / payment / system failure)

None found across either audit pass.

## P1 (production blocker / serious reliability issue)

None found in everything actually audited this pass. Phases not yet
freshly re-walked (full state-machine/idempotency sweep beyond payments/
inventory, broader chaos scenarios beyond the one drill run, load testing,
observability metric-name-vs-dashboard-query verification, K8s runtime
validation against a real cluster, backup/restore) may still surface P1s
— their absence here is not clearance.

## P2 (important, fix if practical)

- No application-level brute-force protection on login/register (edge
  rate-limiting now covers volumetric abuse, not targeted credential
  stuffing against one account). See AUDIT FINDINGS above.
- Known-unmergeable Dependabot PRs left open by design: #9 (Prisma 7),
  #10 (Next.js 16), #14 (TypeScript 7).
- CSP is conservative (no `script-src`/`style-src` lockdown) — a fuller
  policy is real follow-up work, not done this pass to avoid an unverified
  risk of breaking the app.

## P3 (improvement / backlog — must not block release)

- Admin orderNumber/email search has no trigram index for its `ILIKE
  '%term%'` pattern — slow at scale, admin-only, not customer/payment
  facing.
- Dockerfile base image pinned to a tag (`22.23.2-alpine`), not a digest.

## TESTS PASSED

- `@santim/santimpay` unit: 54/54.
- `@santim/web` unit: 30/30.
- `@santim/web` integration (real Postgres): 8/8.
- Typecheck: both packages, clean.
- Lint: both packages, clean, 0 errors/warnings.
- Real `next build` production build: succeeds.
- Real production server boot (`next start`) against a `pnpm prune --prod`
  pruned `node_modules`: real 200 response, all security headers present.
- Real CI Docker build + Trivy vulnerability scan (GitHub runners, real
  network access — this sandbox's Docker daemon has none): both pass.
- Real chaos drill (`chaos:checkout-atomicity`): PASS — see #14 above.
- Real k6 load tests (smoke, 50-VU browsing spike, 12-replica sustained
  health-probe load) against a real production server: all 3 PASS after
  fixing one test-setup misconfiguration (not an app bug) — see #15 above.
- kubeconform -strict schema validation, both overlays: 17/17 valid.
- Every commit's CI run individually confirmed green via `gh run watch`
  with a genuinely uncontested (non-cancelled) result — one earlier watch
  in this pass showed a false "failure" that was actually a concurrency-
  group cancellation from pushing too fast; caught via the GitHub API's
  real `conclusion` field, not assumed.

## TESTS FAILED

None currently open. (One real failure occurred and was fixed mid-pass:
the ShippingLabel cleanup-ordering bug caused by the new FK Restrict
constraint — see #11 above.)

## FIXES COMPLETED

See COMPLETED GATES above for the full list with commit SHAs.

## LAST COMMIT

`135e03e` — docs: verify Grafana dashboard metric names against real app
registrations. On `main`, pushed, CI confirmed green (all 4 jobs,
genuinely uncontested).

## NEXT ACTION

Phases not yet freshly re-walked with this session's evidence standard:

1. **Phase 5/6/7 detail** — state machine legality beyond what Phase 2
   spot-checked (payment/order transitions), idempotency for
   checkout/webhook/refund/cancellation/worker-jobs specifically (payment
   and inventory idempotency were confirmed; refund/cancellation were
   not).
2. **Phase 12/13** — broader test-pyramid review, more chaos scenarios
   (only DB-connection-kill during checkout was run; web/worker restart,
   duplicate webhook, delayed webhook are not yet freshly re-verified this
   pass, though the underlying webhook dedup mechanism was confirmed at
   the unit-test level in the audit).
3. **Phase 15** — load testing now has real evidence for 4 of 5 k6
   scenarios (smoke, browsing, health-probes, order-status-polling — see
   #15 above). Only `webhook-burst.js` was not run this pass — it needs
   `loadtest:seed-webhooks` fixtures and, per its own header comment,
   fixtures regenerated immediately before each run (they embed signed,
   time-sensitive payloads).
4. **Phase 17** — K8s runtime validation: only static (kubeconform) —
   no real cluster was available or provisioned (correctly out of scope
   per the mandate's own Phase 17 guidance).
5. **Phase 19/21** — backup/restore: still not established in this
   codebase (see `PRODUCTION-RELEASE.md` §11) — an infra/hosting decision,
   not resolvable from inside this repo alone.

If continuing: pick the highest-value item above, verify with real
evidence (run it, don't audit-and-assume), fix what's found, commit,
push, watch real CI to a genuinely uncontested completion before the next
push. If not continuing: the honest status is below.

## PRODUCTION READINESS STATUS

**CONDITIONALLY PRODUCTION-READY** for the scope actually audited and
fixed this pass — see the final structured report (delivered to the user
alongside this file) for the complete PASS/FAIL/UNVERIFIED breakdown and
every named limitation. Two full audit passes (application + infra layer)
found zero P0s and zero P1s; every real gap found was fixed, verified with
genuine evidence (real HTTP calls, real CI runs, a real chaos drill, real
schema validation), and pushed. What keeps this "conditional" rather than
unqualified: several phases were not freshly re-walked this pass (broader
chaos scenarios, load testing, observability query-correctness, backup/
restore), and those gaps are named explicitly above and in the final
report rather than assumed clear.
