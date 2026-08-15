# Integration Engineering + DevOps: Zero → Expert

**Built around one real artifact:** a production e-commerce platform integrated with SantimPay,
deployed the way a real company deploys it. You do not learn integration from tutorials. You learn it
by making money move correctly, and by being the person who gets paged when it doesn't.

---

## The shape of this curriculum

Most courses teach *tools* (Docker, Kubernetes, Terraform) and leave you unable to answer "why is
this order stuck?" This one teaches **two disciplines that are actually one job**:

- **Integration engineering** — making two systems that were designed separately agree about reality,
  across an unreliable network, forever.
- **DevOps / platform engineering** — making the system that does that observable, reproducible,
  recoverable, and deployable by anyone on the team at 3pm on a Friday.

The through-line connecting them: **distributed systems have no atomic operations across
boundaries.** Every integration bug and every ops incident is a variation on that one fact.

### How each phase works

```
  READ  →  BUILD  →  BREAK  →  MEASURE  →  WRITE
   │        │         │          │           │
 theory   ship it   inject     prove it    document
 (short)  for real  failure    with data   like an SRE
```

**You are not done with a phase until you have broken it on purpose and recovered from it.** That is
the difference between someone who *used* Kubernetes and someone who can be trusted with it.

---

## Phase map

| Phase | Theme | Weeks | You can honestly claim |
|---|---|---|---|
| **0** | Foundations you cannot skip | 1 | "I understand HTTP, TLS, DNS, and Linux processes" |
| **1** | Integration theory | 1–2 | "I can design an integration against an unreliable partner" |
| **2** | The payment core | 2 | "I built a correct, idempotent payment integration" |
| **3** | Domain modelling & the e-commerce core | 2–3 | "I can model money, inventory, and orders correctly" |
| **4** | The interface layer | 2 | "I ship interfaces that feel expensive and load fast" |
| **5** | Containers & local platform | 1–2 | "I can containerise and orchestrate a real stack" |
| **6** | CI/CD & supply chain | 2 | "My pipeline builds, tests, signs, and ships safely" |
| **7** | Infrastructure as code | 2 | "I provision cloud infra reproducibly" |
| **8** | Kubernetes in earnest | 3 | "I run stateful production workloads on K8s" |
| **9** | Observability & SRE | 2 | "I define SLOs and debug from telemetry, not guesses" |
| **10** | Security & compliance | 2 | "I can pass a security review and a PCI conversation" |
| **11** | Scale & resilience | 2 | "I know where this breaks and what it costs" |
| **12** | Integration breadth | 2 | "I can integrate anything: ERP, shipping, tax, AI, EDI" |

**~24 weeks at 10–15 h/week to genuine senior capability.** Faster is possible; skipping the BREAK
step is not.

---

## Phase 0 — Foundations you cannot skip (Week 1)

Everything later is a leaky abstraction over these. Weakness here shows up as "it works on my
machine" and as inability to debug production.

**Concepts**
- The request lifecycle end to end: DNS → TCP → TLS handshake → HTTP → app → DB → back
- TLS: what a certificate actually proves, SNI, chain of trust, why `curl -k` is a smell
- HTTP semantics: idempotent vs safe methods, status code families, caching headers, keep-alive
- Linux: processes, file descriptors, signals (`SIGTERM` vs `SIGKILL` — this *is* graceful shutdown),
  users/permissions, `/proc`
- Networking: ports, NAT, private vs public IPs, why your webhook endpoint on `localhost` can never
  be called by a payment gateway
- Git as a *data structure*: commits as a DAG, not a list of saves

**Lab 0.1 — Trace a request to the metal.**
`dig`, then `openssl s_client -connect`, then `curl -v`. Draw the full path on paper. Then do the
same against `services.santimpay.com` and note the certificate issuer and TLS version.

**Lab 0.2 — Kill a process correctly.**
Write a Node server that logs on `SIGTERM`, drains in-flight requests, then exits. Prove with `kill
-TERM` that no request is dropped. You have just learned the core of zero-downtime deploys.

**Lab 0.3 — The webhook reachability problem.**
Run a local server, expose it with a tunnel, hit it from outside. This is exactly why testing
SantimPay callbacks locally requires a tunnel — the gateway cannot reach your laptop.

✅ **Gate:** explain, without notes, what happens between pressing Enter on a URL and seeing pixels.

---

## Phase 1 — Integration theory (Weeks 1–2)

The reusable core. Learn it once, apply to every gateway, ERP, and API for the rest of your career.

**Concepts**
- **The eight fallacies of distributed computing** — memorise them; every one costs money
- **Delivery semantics**: at-most-once, at-least-once, exactly-once (and why exactly-once *delivery*
  is a myth while exactly-once *effect* is achievable — via idempotency)
- **Idempotency**: natural keys, idempotency keys, dedupe tables, unique constraints as the last line
- **The dual-write problem**: you cannot atomically write to your DB and call an external API.
  Solutions: transactional outbox, saga, two-phase-ish compensation
- **State machines** over boolean flags. Legal transitions declared, illegal ones impossible
- **Anti-corruption layer**: never let a vendor's vocabulary (`COMPLETED` vs `SUCCESS` vs `declined`)
  into your domain
- **Retry theory**: exponential backoff, jitter (and why fixed backoff creates thundering herds),
  budgets, circuit breakers, bulkheads
- **Webhooks vs polling vs reconciliation** — and why mature systems run all three
- **Contract testing**: consumer-driven contracts, why mocks lie
- **Versioning & deprecation**: URL vs header versioning, expand-contract migration

**Lab 1.1 — Build an idempotent endpoint.**
`POST /charge` that, given the same key twice, charges once and returns the same response body. Prove
it by hammering with 50 concurrent identical requests. Then remove the DB unique constraint and watch
it break under concurrency — that's the lesson.

**Lab 1.2 — Implement a transactional outbox.**
Write order + outbox row in one transaction; a poller publishes. Kill the poller mid-publish. No
message lost, none duplicated in effect.

**Lab 1.3 — Circuit breaker.**
Wrap a flaky dependency; open after N failures, half-open probe, close on recovery. Chart the
latency difference under failure with and without it.

✅ **Gate:** given any third-party API, produce a one-page integration design covering idempotency,
failure modes, retry policy, and reconciliation — before writing code.

---

## Phase 2 — The payment core (Weeks 3–4)

**Read:** [`../docs/01-santimpay-protocol-spec.md`](../docs/01-santimpay-protocol-spec.md) — twice.

**Concepts**
- Money as integer minor units; never floats. Rounding rules; who eats the half-santim
- ES256/JWS signing, key handling, algorithm pinning, replay windows
- Payment intent as an entity distinct from an order
- The redirect-is-not-proof rule
- Reconciliation and the finance report as a first-class feature
- Ledger thinking: double-entry as the correct model for money movement

**Build:** the hardened SDK, checkout flow, webhook receiver, poller, reconciler.

**Break:**
- Send the same webhook 100× concurrently → exactly one fulfilment
- Send a webhook with a tampered amount → rejected + alerted
- Send an unsigned webhook → 401
- Kill the app between "gateway charged" and "DB committed" → reconciler heals it
- Point a testbed key at the production URL → app refuses to boot

✅ **Gate:** you can explain to a finance person why your numbers are right.

---

## Phase 3 — Domain modelling & e-commerce core (Weeks 5–7)

**Concepts**
- Catalog modelling: product vs **variant** (this distinction is where most toy shops die), options,
  SKUs, media, collections
- Inventory: on-hand vs **reserved** vs available; oversell prevention under concurrency; reservation
  TTL
- Cart: guest → authenticated merge, price snapshotting (price at add-time vs checkout-time)
- Pricing: tax-inclusive vs exclusive, discounts, order of application, promotion stacking rules
- Order lifecycle state machine; fulfilment; partial shipment; returns
- Postgres in depth: indexes, transaction isolation levels, `SELECT … FOR UPDATE`, advisory locks,
  N+1 detection, `EXPLAIN ANALYZE`
- Audit trails and event sourcing (where it pays and where it's overkill)

**Break:** 200 concurrent buyers, 1 unit in stock → exactly one sells. Prove it with a load test.

---

## Phase 4 — The interface layer (Weeks 8–9)

"Cinematic" is a performance budget, not a pile of animations.

**Concepts**
- Next.js App Router: Server Components, streaming, `Suspense`, cache semantics, Server Actions
- Rendering strategy per page: static catalog, dynamic cart, edge-cached PDP
- Core Web Vitals: LCP, INP, CLS — and what each one costs in conversion
- Motion that means something: shared-element transitions, orchestration, `prefers-reduced-motion`
- Design systems: tokens, spacing scale, type scale, dark mode
- Accessibility: keyboard paths, focus management, ARIA for a real checkout, WCAG AA contrast
- Image pipeline: AVIF/WebP, responsive `srcset`, priority hints

✅ **Gate:** Lighthouse ≥ 95 performance/accessibility on the PDP **with** the animations on.

---

## Phase 5 — Containers & the local platform (Weeks 10–11)

- Images vs containers vs registries; layers, caching, and why layer order dictates build time
- Multi-stage builds; distroless/alpine trade-offs; non-root users; `.dockerignore`
- Image size discipline; reproducible builds; pinning by digest
- Compose for the whole stack: app, Postgres, Redis, worker, MinIO, mailhog
- Healthchecks, restart policies, dependency ordering, resource limits
- Volumes, networks, secrets — and why env vars leak

**Break:** `docker compose kill` the database mid-checkout. What does the customer see? Fix it.

---

## Phase 6 — CI/CD & software supply chain (Weeks 12–13)

- Pipeline stages: lint → typecheck → unit → integration (with real Postgres in a service container)
  → build → scan → sign → deploy
- Caching strategy; matrix builds; required checks and branch protection
- Deploy strategies: rolling, blue/green, canary, feature flags. Which one for a payment system?
- Database migrations in CI/CD — **expand-contract**, never a destructive migration in a deploy
- Supply chain: SBOM (Syft), vulnerability scan (Trivy/Grype), image signing (cosign), provenance
  (SLSA), dependency pinning, Dependabot/Renovate
- Secrets in CI: OIDC federation over long-lived keys

✅ **Gate:** a green pipeline that ships to staging on merge, with a one-command rollback you have
actually exercised.

---

## Phase 7 — Infrastructure as code (Weeks 14–15)

- Terraform: providers, state (remote + locking), modules, workspaces, drift, `plan` as a review
  artifact
- Environments without copy-paste; DRY module design
- Networking: VPC, subnets, security groups, load balancers, TLS termination, DNS
- Managed vs self-hosted Postgres — the honest cost/ops trade-off
- Ansible for the config-management half; when IaC ends and CM begins
- Cost as a design constraint: tagging, budgets, right-sizing

---

## Phase 8 — Kubernetes in earnest (Weeks 16–18)

- Architecture: control plane, kubelet, scheduler, controllers, the reconciliation loop as *the* K8s
  idea
- Workloads: Deployment, StatefulSet, Job, CronJob (your reconciler is a CronJob)
- Networking: Service types, Ingress/Gateway API, DNS, NetworkPolicy
- Config: ConfigMap, Secret, External Secrets Operator, sealed secrets
- Storage: PV/PVC, StorageClass, and the "should the DB live in K8s?" debate
- Scheduling: requests/limits, QoS classes, affinity, taints, PDBs, topology spread
- Autoscaling: HPA, VPA, KEDA (queue-depth scaling for your payment worker), Cluster Autoscaler
- Probes done right: liveness ≠ readiness ≠ startup — misconfiguring these causes outages
- Helm and Kustomize; GitOps with Argo CD; progressive delivery with Argo Rollouts
- Service mesh: what it buys, what it costs, when to say no

**Break:** drain a node during checkout. Zero failed payments, or you're not done.

---

## Phase 9 — Observability & SRE (Weeks 19–20)

- The three pillars, honestly: metrics (Prometheus), logs (Loki), traces (OpenTelemetry/Tempo) — and
  why traces matter most for integrations
- Instrumenting the payment path end-to-end; trace-id propagation into webhook handling
- RED and USE method dashboards; Grafana that a stranger can read at 3am
- **SLIs, SLOs, error budgets** — and using the budget to decide whether to ship
- Alerting that respects humans: symptom-based, actionable, no flapping, clear ownership
- Incident response: roles, comms, timeline, blameless postmortem
- Runbooks as code, tested in game days

**Lab:** define an SLO for "checkout success rate", instrument it, then break it deliberately and
watch the burn-rate alert fire.

---

## Phase 10 — Security & compliance (Weeks 21–22)

- Threat modelling with STRIDE on the checkout flow specifically
- OWASP Top 10 applied: this codebase, these endpoints
- AuthN/AuthZ: sessions vs JWT, refresh rotation, RBAC, admin privilege separation
- Secrets management end to end; rotation without downtime
- Webhook security: signature verification, replay windows, timing-safe comparison
- Rate limiting, bot defence, card-testing/enumeration defence
- **PCI DSS SAQ-A** — why redirect-based hosted checkout keeps you *out* of card scope, and what the
  Ethiopian regulatory equivalent expects
- Data protection: PII minimisation, encryption at rest/in transit, retention, right to erasure
- Container/K8s hardening: non-root, read-only rootfs, seccomp, Pod Security Standards, admission
  policy (OPA/Kyverno)

---

## Phase 11 — Scale & resilience (Weeks 23–24)

- Caching layers: browser → CDN → app → Redis → DB, and invalidation strategy per layer
- Read replicas, connection pooling (PgBouncer), partitioning
- Queues and async workers; backpressure; dead-letter queues and how you actually drain one
- Load testing (k6): find the knee, not just the average
- Chaos engineering: hypothesis → inject → observe → fix
- DR: RPO/RTO targets, backup **restore** drills (an untested backup is not a backup), multi-AZ
- Capacity planning and cost per order

---

## Phase 12 — Integration breadth (Weeks 25–26)

Prove the theory generalises. Add, to the same platform:

- **Shipping/logistics** — rate quoting, label generation, tracking webhooks
- **Tax** — tax engine integration, jurisdiction rules
- **ERP/accounting** — batch + file-based integration, SFTP, CSV/EDI, the world of nightly jobs
- **Search** — Meilisearch/Elastic, index sync via outbox events
- **Email/SMS** — transactional messaging, template management, delivery webhooks
- **Analytics** — server-side event pipeline, not just a browser pixel
- **AI** — recommendations and support agents; the Claude API as just another integration with the
  same rules (idempotency, timeouts, cost budgets, graceful degradation)
- **Message brokers** — Kafka/RabbitMQ, event-driven choreography vs orchestration
- **iPaaS & the enterprise view** — ESB history, API gateways, MuleSoft/Camel patterns, when
  middleware is the right answer

---

## The daily rhythm that makes this stick

| Time | Activity |
|---|---|
| 20 min | Read the phase's concept notes |
| 90 min | Build — commit something every session |
| 20 min | Break it deliberately; record what happened |
| 15 min | Write: what surprised you, in your own words |

The writing is not optional. **If you cannot explain it, you have not learned it — you have watched
it happen.** Your `docs/` folder at the end of this is your portfolio and your interview script.

---

## How you will know you're an expert

Not "I know Kubernetes." It's:

1. You reach for a state machine before a boolean.
2. You ask "what happens if this is delivered twice?" reflexively.
3. You can read a Grafana panel and form a hypothesis in under a minute.
4. You write the runbook before the incident.
5. You can say "we should not build this" with reasons.
6. Someone else can deploy, debug, and roll back your system **without you** — because you wrote it
   down.

---

*Next: [`01-integration-fundamentals.md`](./01-integration-fundamentals.md) — the theory of Phase 1
in depth, with the SantimPay integration as the worked example.*
