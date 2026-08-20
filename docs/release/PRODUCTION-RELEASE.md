# Production Release Procedure

This document is the human deployment runbook for santim-commerce. It
describes how to take the code in this repository and deploy it into a
real environment. **No step in this document has been executed against a
production system by any automated process** — deployment is a deliberate
human action, triggered by pushing a version tag (see §6). Everything up
to that point (build, scan, sign) already runs in CI on every push to
`main`; only the actual cluster rollout waits for a human-created tag.

## 1. Release identification

- **Release candidate commit**: `15e55cab65cf107bf75f5d7ec6f3383585777c8e`
  (`main`, as of 2026-08-20). Re-check before tagging:
  `git log origin/main --oneline -1`.
- **Application version**: `0.1.0` (root `package.json`). No version tag
  has been pushed yet — this repository has not had a tagged release. See
  §6 for how to cut one.
- CI status for this commit: verify with
  `gh run list --branch main --repo Nebyudejenie/santim-commerce --limit 1`
  before treating it as a release candidate. Do not tag a commit whose CI
  is red.

## 2. Required environment variables

Full authoritative list: [`apps/web/.env.example`](../../apps/web/.env.example).
Summary:

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` in every real environment |
| `DEPLOY_ENV` | yes | `development` \| `staging` \| `production` — decoupled from `NODE_ENV`; only `production` enforces the testbed-vs-real-money and HTTPS boot-time guards (see `apps/web/src/server/config/env.ts`) |
| `LOG_LEVEL` | yes | `info` in production |
| `DATABASE_URL` | yes | Postgres connection string, `sslmode=require` in production |
| `APP_URL` | yes | Public HTTPS origin — SantimPay must be able to reach `APP_URL/api/webhooks/santimpay` from the internet |
| `SANTIMPAY_ENVIRONMENT` | yes | `testbed` \| `production` — a testbed key will not authenticate against production URLs |
| `SANTIMPAY_MERCHANT_ID` | yes | Issued per environment on the SantimPay integration group |
| `SANTIMPAY_PRIVATE_KEY` or `SANTIMPAY_PRIVATE_KEY_B64` | yes | See §3 — this is a secret, not a plain env var, in any real environment |
| `SANTIMPAY_GATEWAY_TOKEN` | yes when `SANTIMPAY_ENVIRONMENT=production` | Per SantimPay's integration document |
| `SANTIMPAY_TIMEOUT_MS` | no (default `15000`) | |
| `WEBHOOK_MAX_AGE_SECONDS` | no (default `300`) | Rejects stale webhook callbacks |
| `RESERVATION_TTL_MINUTES` | no (default `20`) | How long checkout holds stock |
| `SESSION_SECRET` | yes | Generate with `openssl rand -base64 48` — this is a secret |
| `METRICS_TOKEN` | yes in k8s | Bearer token protecting `/api/metrics`; generate with `openssl rand -hex 32` |

## 3. Required secrets

**Never commit real values for any of these.** In Kubernetes, they belong
in the `santim-web-secrets` Secret (template:
[`infra/k8s/base/secret.yaml`](../../infra/k8s/base/secret.yaml)), populated
in real environments by External Secrets Operator (from AWS/GCP Secret
Manager or Vault) or Sealed Secrets — never `kubectl apply -f` with real
values in plaintext.

1. **`SANTIMPAY_PRIVATE_KEY_B64`** — the highest-value secret in this
   system. SantimPay holds a matching copy; this key authenticates both
   outbound payment requests AND inbound webhook signature verification
   (see [`docs/01-santimpay-protocol-spec.md`](../01-santimpay-protocol-spec.md)
   §1.1). A leak lets an attacker both spend from escrow and forge
   webhooks. Rotate via the documented procedure:
   [`docs/runbooks/03-key-rotation.md`](../runbooks/03-key-rotation.md).
2. **`SANTIMPAY_GATEWAY_TOKEN`** — required for production SantimPay calls.
3. **`SESSION_SECRET`** — signs/protects session handling.
4. **`DATABASE_URL`** — includes the database password; use `sslmode=require`.
5. **`METRICS_TOKEN`** — protects `/api/metrics` from unauthenticated scraping.
6. **`KUBE_CONFIG`** (GitHub Actions secret, not app runtime) — cluster
   credentials used only by `.github/workflows/deploy.yml`'s `deploy` job,
   which runs under a `production` GitHub Environment (supports requiring
   manual approval — configure this in the repo's Environment settings).

No admin password lives anywhere in config. `/admin` is gated by a real
session against the `User` table (`role` STAFF/ADMIN) — see §7 for
bootstrapping the first admin account.

## 4. Database migrations

Three migrations exist today, all additive (no destructive
`DROP COLUMN`/`DROP TABLE` found on review):

```
apps/web/prisma/migrations/
  20260807111000_init
  20260812123332_add_sessions
  20260817085838_add_shipping_labels
```

**Procedure**: exactly one process runs migrations, before any new
application code serves traffic. In Kubernetes this is
[`infra/k8s/base/job-migrate.yaml`](../../infra/k8s/base/job-migrate.yaml), a
one-shot `batch/v1` Job (never a `Deployment` — a Deployment's N replicas
would race). `deploy.yml` already sequences this correctly: delete any
previous migration Job, apply manifests, `kubectl wait
--for=condition=complete job/santim-db-migrate`, **then** roll the
Deployments. Do not reorder this.

Manual/local equivalent: `pnpm --filter @santim/web db:deploy` (wraps
`prisma migrate deploy`) against the target `DATABASE_URL`.

## 5. Docker image

- Built from [`infra/docker/Dockerfile`](../../infra/docker/Dockerfile),
  multi-stage, runs as a non-root `USER node` in the final stage.
- CI builds and Trivy-scans this exact Dockerfile on every push to `main`
  (`.github/workflows/ci.yml`, "Build & scan container image" job) —
  HIGH/CRITICAL vulnerabilities fail the build; documented exceptions in
  [`.trivyignore`](../../.trivyignore).
- **This session could not run a local `docker build`** — this sandbox's
  Docker daemon has no network egress (`npm error getaddrinfo EAI_AGAIN`
  reaching `registry.npmjs.org` from inside the build), a sandbox
  limitation, not a code defect. Every CI run's Docker build (with real
  network access) succeeded for every commit in this release — verified
  via `gh run watch` for each push, not assumed.
- Release builds are pushed to `ghcr.io/nebyudejenie/santim-commerce`,
  signed keylessly with `cosign` (Sigstore/Fulcio OIDC — no long-lived
  signing key in repo secrets), and deployed **by digest**, never by a
  mutable tag (`.github/workflows/deploy.yml`).
- SBOM (SPDX JSON) generated and uploaded as a CI artifact on every build,
  90-day retention.

## 6. Deployment steps (human-triggered)

1. Confirm the release candidate commit's CI is green (§1).
2. Update `version` in the root and package `package.json` files if this
   is a versioned release (not yet done for `0.1.0` → decide the next
   version with the team; this is a human/product decision, not made
   here).
3. Create and push an annotated tag matching `.github/workflows/deploy.yml`'s
   trigger pattern `v*.*.*`:
   ```
   git tag -a v0.1.0 -m "santim-commerce v0.1.0"
   git push origin v0.1.0
   ```
   This is the action that starts the real deploy workflow — **it has
   intentionally not been done by any automated process in this session.**
4. The `deploy` job requires the `production` GitHub Environment; if
   configured with required reviewers, it pauses for manual approval
   there.
5. `deploy.yml` then: builds & pushes the image, signs it, deletes any
   prior migration Job, applies `infra/k8s/overlays/production` with the
   image rewritten to this build's digest, waits for the migration Job to
   complete, `kubectl set image` on both Deployments (redundant with the
   apply step, kept as a safety net), waits for rollout, and automatically
   runs `kubectl rollout undo` on both Deployments if any step fails.
6. This entire step requires a real target cluster with `KUBE_CONFIG`
   configured as a GitHub Actions secret — **not configured or verified in
   this session**, since doing so would require real cluster credentials
   this process must not handle. The human operator provisions the
   cluster and secret.

## 7. Post-deploy: bootstrap the first admin

No admin credential ships anywhere. After a fresh deploy, create the first
admin account by running, against the deployed database:

```
BOOTSTRAP_ADMIN_EMAIL=you@example.et BOOTSTRAP_ADMIN_PASSWORD='...' \
  pnpm --filter @santim/web run create-admin
```

(Idempotent — safe to re-run to reset a lost password.) Full procedure:
[`infra/k8s/README.md`](../../infra/k8s/README.md) §"Bootstrapping the
first admin user".

## 8. Health checks

- Liveness: `GET /api/health` (`infra/k8s/base/deployment-web.yaml`,
  `initialDelaySeconds: 10`, `periodSeconds: 15`).
- Readiness: `GET /api/ready` (`initialDelaySeconds: 5`, `periodSeconds: 10`).
- `kubectl rollout status` in `deploy.yml` already blocks the deploy job on
  these succeeding — a bad rollout fails CI/CD loudly, before a customer
  notices.

## 9. Smoke tests

`infra/load-testing/k6/smoke.js` — 1 virtual user, hits every documented
public route once (`/`, `/shop`, a collection, a product, `/cart`,
`/login`, `/register`, `/api/health`), zero-tolerance for failed requests,
p95 < 2s. Run against the freshly deployed environment:

```
BASE_URL=https://<deployed-host> k6 run infra/load-testing/k6/smoke.js
```

This has not been run against a real deployed environment in this session
— there is none. It has been reviewed for correctness, not executed
end-to-end post-deploy.

## 10. Rollback

- **Automatic**: `deploy.yml`'s `deploy` job runs `kubectl rollout undo`
  on both `santim-web` and `santim-worker` if any step in the job fails
  (build, migration wait, or rollout wait).
- **Manual**: `kubectl rollout undo deployment/santim-web -n santim-commerce`
  and the same for `santim-worker`. Because images are deployed by digest,
  the previous ReplicaSet's pod template still references the exact prior
  image — a rollback is a real, verifiable return to the last-known-good
  build, not a best-effort guess.
- **Database**: migrations in this repo are additive-only by convention
  (see §4) — a code rollback does not require a matching down-migration.
  If a future migration is ever non-additive, that convention must hold or
  rollback safety breaks; see `docs/01-santimpay-protocol-spec.md`'s
  expand-contract migration guidance.

## 11. Backup requirements

**Not established or verified in this session.** This repository does not
contain an automated database backup mechanism (e.g. a scheduled
`pg_dump`/WAL-archiving CronJob) as of commit `15e55ca`. A backup/restore
*drill procedure* exists as a runbook —
[`docs/runbooks/05-backup-restore-drill.md`](../runbooks/05-backup-restore-drill.md)
— but the actual backup mechanism it assumes (managed Postgres snapshots,
or an equivalent) is an infrastructure decision for whatever database
hosting the human operator chooses, not something this codebase provisions
itself. **Do not consider backups solved by this document's existence
alone.**

## 12. Monitoring requirements

- Prometheus scrape config: [`infra/observability/prometheus.yml`](../../infra/observability/prometheus.yml).
- App exposes `/api/metrics` (bearer-token-protected via `METRICS_TOKEN`).
- Worker exposes its own metrics port (`WORKER_METRICS_PORT`, default
  `9091` per `infra/k8s/base/configmap.yaml`).
- A Grafana dashboard is checked in and auto-provisioned:
  [`infra/observability/grafana/dashboards/santim-commerce.json`](../../infra/observability/grafana/dashboards/santim-commerce.json),
  wired via [`infra/observability/grafana/provisioning/`](../../infra/observability/grafana/provisioning/)
  (datasource pointed at Prometheus, dashboard auto-loaded on Grafana
  boot). Reviewed its panel list: it does track real business-health
  signals, not just infra metrics — checkout outcomes/failure reasons,
  amount mismatches, unresolved payments, payment settlement status,
  gateway latency, webhook results, expired reservations — alongside
  process CPU/memory. **Verified**: every metric name referenced by the
  dashboard's PromQL queries (`santim_orders_placed_total`,
  `santim_checkout_failures_total`, `santim_checkout_sessions_total`,
  `santim_payment_settlements_total`, `santim_payment_amount_mismatch_total`,
  `santim_gateway_request_duration_seconds_{bucket,count}`,
  `santim_webhook_requests_total`, `santim_payments_unresolved`,
  `santim_inventory_reservations_expired_total`, plus the standard
  `process_cpu_seconds_total`/`process_resident_memory_bytes`) has an exact
  match in `apps/web/src/server/observability/metrics.ts`'s real metric
  registrations — no dashboard-vs-app name drift.

## 13. Fixed since this document's first version

For traceability — these were real gaps found by a dedicated audit after
this document was first written, fixed, and verified with real evidence
(not just this document being edited to claim so): the app now sets all 6
standard OWASP response security headers on every route (`next.config.ts`,
verified live against a running server); `ingress.yaml` now enforces a
real per-IP rate limit at the edge on everything except the SantimPay
webhook path; Order's financial/audit-trail children (OrderLine,
OrderEvent, PaymentIntent, ShippingLabel) can no longer be silently
destroyed by a parent-row delete; 3 missing indexes for real, confirmed
admin-dashboard query patterns were added; the Docker image no longer
ships devDependencies and now has a HEALTHCHECK; the repository root
README (referenced throughout this document) now exists. A real chaos
drill (`pnpm run chaos:checkout-atomicity` — kills a Postgres backend
connection mid-transaction during checkout) was executed against a real
database and passed: no partial order, no leaked inventory reservation,
cart correctly left resumable. Full detail with commit SHAs:
`docs/PROJECT-EXECUTION-STATE.md`.

## 14. Known risks / open items at this release

- PRs #9 (Prisma 7), #10 (Next.js 16), #14 (TypeScript 7) intentionally
  not merged — each is a real breaking migration, documented in
  [`docs/PROJECT-EXECUTION-STATE.md`](../PROJECT-EXECUTION-STATE.md).
  Staying on the current majors is a deliberate, evidence-based choice,
  not neglect — re-evaluate periodically.
- Automated database backups: not established in this codebase — see §11.
  Confirm with whatever managed database service is actually used in the
  target environment before going live. **Still true as of this update —
  unchanged.**
- No version tag has ever been pushed for this project; `v0.1.0` in this
  document is illustrative, not yet real. A human must decide the actual
  version number and create the tag (§6).
- No application-level brute-force protection on login/register — a real
  per-IP rate limit now exists at the edge (§ ingress.yaml, added after
  this document's first version), but that bounds volumetric abuse, not a
  targeted attacker slow-guessing one account's password. A proper fix
  (account lockout / backoff) needs careful design to avoid becoming its
  own DoS vector against a legitimate user — deliberately not implemented
  under time pressure; see `docs/PROJECT-EXECUTION-STATE.md`'s P2 list.
- The Content-Security-Policy shipped is intentionally conservative
  (`frame-ancestors`/`base-uri`/`form-action` only, no `script-src` lockdown)
  — a fuller policy is real follow-up work, not verified safe to ship this
  pass.
- Admin order/email search (`ILIKE '%term%'`) has no index that can serve
  a leading wildcard — will get slow at scale. Admin-only, not
  customer/payment facing; a `pg_trgm` GIN index is the fix when needed.
- No load test has been run against a real deployed environment (k6
  scripts exist and were reviewed for correctness, not executed against a
  live target — there is none yet).
- This document has not itself been exercised end-to-end against a real
  target environment (no such environment exists yet for this project) —
  every step above is derived from reading the actual, real configuration
  files in this repository, cross-referenced against what CI has actually
  verified, not from assumption.
