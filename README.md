# santim-commerce

A real e-commerce platform integrated with [SantimPay](https://santimpay.com), an Ethiopian
payment aggregator sitting in front of Telebirr, CBE Birr, bank rails, and SantimPay's own wallet.
Built to demonstrate what payment integration actually requires in production: idempotency,
concurrency-safe inventory, a real state machine, webhook signature verification, and the
observability/deployment plumbing to run it for real — not a tutorial checkout form.

## Stack

- **App**: Next.js 15 (App Router, Server Actions) + React 19, TypeScript, Prisma ORM on Postgres.
- **Payment SDK**: `packages/santimpay` — a standalone, hardened SantimPay client (ES256 request
  signing, webhook signature verification, bounded retries, typed error taxonomy, integer-only
  money) with zero dependency on the web app, unit-tested on its own.
- **Worker**: a separate process (`apps/web/src/worker`) polling unresolved payments and expiring
  abandoned inventory reservations — deliberately not folded into request handling.
- **Infra**: Docker (multi-stage, non-root, signed images), Kubernetes manifests
  (`infra/k8s`), Prometheus + Grafana (`infra/observability`), k6 load tests
  (`infra/load-testing`).

## Getting started

```bash
docker compose up -d --build       # postgres, migrate (one-shot), web, worker
docker compose exec web sh -c \
  "BOOTSTRAP_ADMIN_EMAIL=you@example.et BOOTSTRAP_ADMIN_PASSWORD='...' pnpm run create-admin"
```

`docker-compose.yml` requires `APP_URL`, `SANTIMPAY_MERCHANT_ID`, `SANTIMPAY_PRIVATE_KEY_B64`,
`SESSION_SECRET`, and `METRICS_TOKEN` as environment variables — see
[`apps/web/.env.example`](apps/web/.env.example) for what each one means and how to generate it.
SantimPay cannot call back to `localhost`; for local webhook testing, tunnel first
(`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and set `APP_URL` to the
tunnel's HTTPS URL.

For day-to-day development without Docker:

```bash
pnpm install
pnpm --filter @santim/web db:deploy   # apply migrations to a local Postgres
pnpm --filter @santim/web dev
```

## Working in this repo

```bash
pnpm -r typecheck      # both packages
pnpm -r lint            # both packages (ESLint)
pnpm --filter @santim/santimpay test         # SDK unit tests — no database needed
pnpm --filter @santim/web test:unit          # state machine etc. — no database needed
pnpm --filter @santim/web test:integration   # requires a real Postgres (docker compose up -d postgres)
```

## Repository layout

```
apps/web/               Next.js app: storefront, admin, API routes, worker, Prisma schema
packages/santimpay/      Standalone SantimPay SDK — signing, webhooks, retries, money
infra/docker/            Dockerfile
infra/k8s/                Kubernetes manifests (base + staging/production overlays)
infra/observability/     Prometheus config, Grafana dashboard + provisioning
infra/load-testing/       k6 scripts (smoke, browsing, checkout, webhook burst)
docs/                     Protocol spec, runbooks, execution state, release procedure
curriculum/               A 12-phase integration-engineering/DevOps curriculum built around
                           this codebase as its running example — not required reading to
                           work on the app itself
```

## Documentation

- [`docs/01-santimpay-protocol-spec.md`](docs/01-santimpay-protocol-spec.md) — the SantimPay
  integration itself: signing, webhooks, the payment state machine, what the vendor SDK gets
  wrong.
- [`docs/runbooks/`](docs/runbooks/) — stuck payments, escrow depletion, key rotation, webhook
  outages, backup/restore, chaos drills.
- [`docs/release/PRODUCTION-RELEASE.md`](docs/release/PRODUCTION-RELEASE.md) — the human
  deployment procedure: required secrets, migration steps, rollback.
- [`docs/PROJECT-EXECUTION-STATE.md`](docs/PROJECT-EXECUTION-STATE.md) — current engineering
  status: what's verified, what's open, what's next.
- [`infra/k8s/README.md`](infra/k8s/README.md) — manifest layout, secret handling, deploy order.

## Security

Do not open a public issue for a suspected vulnerability. See
[`docs/runbooks/03-key-rotation.md`](docs/runbooks/03-key-rotation.md) if you believe the
SantimPay private key or a session secret may have leaked.
