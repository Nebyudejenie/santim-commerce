# Project Execution State

Persistent engineering log for the santim-commerce production-readiness push.
This file is the resume point if execution is interrupted: read this file,
check `git log --oneline -15` and `git status`, check `gh pr list --state
open`, and continue from NEXT ACTION.

Last updated: 2026-08-20, commit `a31a199` on `main` (pushed and confirmed
== `origin/main`).

## CURRENT PHASE

Phase 1 (Repository Sync) — complete. Phase 2 (Repository Audit) — complete,
two full passes (application-layer: dead code, payments, inventory,
authorization, secrets; infra-layer: DB schema, migrations, security headers,
rate limiting, container security, K8s manifests, Trivy ignore quality).
Phase 4 sub-slice (customer order visibility) — fixed. Phase 9 (Database
Integrity) — fixed (FK guardrails, missing indexes). Phase 11 (Security
Audit) sub-slices — fixed (response security headers, edge rate limiting,
container hardening). Phase 13 (Chaos Testing) — one real drill executed
with fresh evidence (checkout transaction atomicity under a killed DB
connection). Phase 16 (Docker) — fixed (dev-dependency pruning, HEALTHCHECK)
and validated with a real CI Docker build + Trivy scan. Phase 18 (CI/CD)
sub-slice (lint) — fixed. Phase 20 (Documentation) — root README added.
Phases 3, 5–8, 10, 12, 14–15, 17, 19, 21 — not freshly re-walked this pass;
see NEXT ACTION.

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

`a31a199` — docs: add repository root README. On `main`, pushed, CI
confirmed running/green (verify final status with `gh run list --branch
main --limit 1` if resuming).

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
3. **Phase 14/15** — observability (verify the Grafana dashboard's actual
   PromQL queries resolve against real metric names the app emits — flagged
   as unverified when the release doc was written; no load test was run
   this pass despite k6 scripts existing and being reviewed).
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
