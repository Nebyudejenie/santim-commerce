# Phase 11 — Scale & Resilience

*Same method as Phases 1–10: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. `infra/load-testing/README.md` names this exact
phase by number too — the fourth instance of a pattern this curriculum keeps finding: this
codebase's own comments were written expecting to be read alongside it.*

---

## Why this phase exists

Every earlier phase proved something *works*. This phase is about what happens once it has to work
under load, under partial failure, and after data loss — three conditions this codebase has tested
to genuinely different degrees, and the honest differences between them are the most useful thing
this phase can teach.

---

## 1. Caching layers — mostly absent, and one direct consequence of a decision made earlier in this curriculum

The master plan's own outline names a five-layer chain: browser → CDN → app → Redis → DB. Read this
codebase against that chain and most of it isn't there. **No CDN configuration exists anywhere in
this repository** — whatever edge caching happens for static assets is whatever Next.js's own
default asset handling provides, not anything this project configured deliberately. **Redis is
gone entirely** — and this isn't a fresh finding, it's a direct callback to Phase 5 §4: Redis was
provisioned in `docker-compose.yml`, wired into both `web` and `worker`'s environment, and removed
during this same curriculum-writing effort specifically because nothing ever consumed it — no
`REDIS_URL` field in `env.ts`'s validated schema, no redis client dependency anywhere in the
monorepo. **The app layer's own caching is exactly one deliberate, load-bearing decision, and it's
worth being precise that it's not really "caching" in the CDN/Redis sense**: `db.ts`'s
`globalThis`-cached Prisma client singleton exists to survive Next.js dev-mode hot-reload without
exhausting `max_connections`, not to reduce database round-trips for repeated identical queries.

**What this means concretely for the load-testing thresholds already committed to this repo:**
`infra/load-testing/README.md`'s own threshold table states it directly —
*"tighten them once caching (curriculum Phase 11) is in place"* — meaning the `page` tier's
1200ms/2500ms p95/p99 budget for full SSR page renders is calibrated for **real, uncached Prisma
queries on every request**, because that's genuinely what this codebase does today. Adding a real
caching layer later isn't optional polish — it's the specific, named prerequisite this project's
own load-test thresholds are already written to expect, sitting unfulfilled.

---

## 2. Read replicas, connection pooling, partitioning — all absent; what's real instead

No PgBouncer, no read replica configuration, no table partitioning anywhere in this codebase — a
single Postgres connection (Phase 7 §0's already-established gap: nothing describes how even the
*primary* database gets provisioned, let alone a replica topology). What genuinely exists at the
connection-management layer is narrower and worth understanding precisely for what it actually
solves, since it's easy to mistake for more than it is:

```ts
// db.ts
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ /* ... */ });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

The module's own comment: *"Next.js dev mode hot-reloads modules on every edit. A `new
PrismaClient()` at module scope therefore creates a NEW connection pool on every save, and within a
minute of editing you exhaust `max_connections` on Postgres... Caching on `globalThis` survives the
reload because the global object is not re-created."* **This solves a development-time
module-lifecycle bug, not a production scaling problem.** Prisma itself manages a connection pool
internally per `PrismaClient` instance — this pattern just ensures only one such instance (and
therefore one such pool) exists per process, in dev. It says nothing about whether that one pool's
size is appropriate for real production concurrency, whether N replicas of the `web` Deployment
each maintaining their own pool could collectively exceed Postgres's `max_connections` under real
load (a genuine, unaddressed question — Phase 8 §9's HPA can scale `web` to 12 replicas; nothing
here reasons about what 12 independent connection pools do to a single, unpooled Postgres
instance), or whether a pooler like PgBouncer would be needed to absorb that. **The gap is real,
and it's precisely the kind of thing that looks fine at the replica counts this project has ever
actually tested (per its own load-test scripts) and becomes a real incident exactly at the scale
the HPA is configured to reach.**

---

## 3. Queues and async workers — a poller, not a queue, and an informal dead-letter path

Phase 9 §5 already established this precisely in the alerting context; restated here for this
phase's own framing: the worker has no queue at all. `settleDuePayments()` polls Postgres directly
for `PaymentIntent` rows past their `nextPollAt`, in batches:

```ts
const BATCH = 25;
// ...
const due = await prisma.paymentIntent.findMany({
  where: { status: { in: ["CREATED", "PENDING"] }, nextPollAt: { lte: new Date() } },
  orderBy: { nextPollAt: "asc" },
  take: BATCH,
});
```

`BATCH = 25` is this project's actual backpressure mechanism — not a formal queue depth limit or a
`Bulkhead` pattern (Phase 1 §7.4's introduced-but-not-built concept), just a hard cap on how much
work one tick claims, so a large backlog degrades into "it takes longer to catch up" rather than
attempting unbounded concurrent work against Postgres and SantimPay's API simultaneously.

**The outbox's own retry path is the closest thing to a dead-letter mechanism, and it's informal —
worth being precise about the difference from a real DLQ:**

```ts
const backoffMs = Math.min(2 ** attempts * 1000, 30 * 60_000);
// Exponential backoff, capped. After ~10 attempts it needs a human, and
// the dashboard query for "unpublished older than 1h" will surface it.
```

A formal dead-letter queue is usually its own distinct destination — a separate queue or table a
message moves *into* after exhausting retries, with its own explicit "drain the DLQ" operational
procedure. This codebase has neither: a permanently-failing `OutboxMessage` row just keeps
re-attempting on an ever-longer (but capped at 30 minutes) backoff, forever, and the comment's own
admission — *"After ~10 attempts it needs a human"* — is a statement of intent, not a mechanism.
Nothing automatically flags a row that's failed 10 times as categorically different from one that's
failed twice; the "dashboard query for unpublished older than 1h" the comment references is manual
investigation, not an automated dead-letter path with its own alert (Phase 9 §5 already covered
what real alerting here would look like). **"How you actually drain one," the master plan's own
phrase, doesn't have a real answer in this codebase yet — because there isn't yet a real DLQ to
drain, only a query someone has to remember to run.**

---

## 4. Load testing — a real, thoughtfully-scoped suite, honestly not yet exercised to find its own limits

`infra/load-testing/`'s five k6 scripts are real, not scaffolding: `smoke.js` (the CI gate — one
VU through every route), `browsing.js` (ramping catalogue traffic with realistic funnel weights),
`order-status-polling.js` (100 concurrent "confirming payment" customers), `webhook-burst.js` (a
SantimPay delivery spike against a tight latency budget), `health-probes.js` (what the cluster's
own liveness/readiness checks do to the app under load, Phase 8 §8's probes given a real load
profile). The README's threshold table is real too, three tiers keyed to what's actually being
measured — `fast` (300ms/800ms p95/p99, health/ready/status-polling), `page` (1200ms/2500ms, full
SSR renders, §1's uncached-Prisma-query caveat already noted), `webhook` (500ms/1500ms — *"has a
real redelivery deadline, not just a UX target,"* tying directly to Phase 2 §5's FAST requirement
on the webhook receiver itself).

### 4.1 The honest engineering story behind what's NOT load-tested

The README's own section on why checkout/cart mutations aren't driven from k6 directly is worth
reading in full for what it demonstrates about when to stop pursuing an approach, not just for its
conclusion:

> Adding to cart and checking out are Server Actions bound through `useActionState` — a real
> browser invokes them via a JS-mediated `fetch` carrying a `Next-Action` header and an
> internally-encoded closure reference, not a plain form POST. I found the action IDs in
> `.next/server/server-reference-manifest.json` and tried replaying the wire protocol by hand; it
> returned an opaque `500 [Error: Connection closed]`. That's the correct outcome to walk away
> from — reverse-engineering an internal, version-fragile Next.js protocol to shave a small amount
> of "realism" off a load test is a bad trade, and a load test built on a request shape that isn't
> actually what browsers send would be worse than not having one.

**This is a real, documented investigation that reached a negative result and stopped, rather than
either giving up on load testing entirely or shipping something fragile anyway** — the two
substitutes the README names instead (the real, already-proven 200-concurrent-buyers reservation
test, Phase 3 §2.3; and `order-status-polling.js` covering the traffic pattern that actually
dominates load, since every unresolved payment polls every 3 seconds for minutes) are honest
compensations for a real gap, not a pretense that the gap doesn't exist. The README even names the
correct future tool precisely — k6's `k6/browser` module, real Chromium via CDP — rather than
leaving "figure it out later" unspecified.

### 4.2 "Find the knee, not just the average" — not yet done

The master plan's own framing for this section is specific: load testing's value isn't confirming
the system is fast under normal load, it's finding the point where it *stops* being fast — the
"knee" in a latency-versus-load curve, past which p99 latency (or error rate) stops scaling
linearly and starts degrading sharply. **Nothing in this codebase records that a real knee-finding
run has ever actually happened.** The threshold table's own framing — *"starting thresholds, not
laws of physics — tune them against your actual infrastructure once you have a baseline run"* — is
explicit that even a *baseline* run hadn't happened as of this document being written, let alone a
deliberately-escalating run designed to find where the system actually breaks. The scripts exist;
the knee has never been found.

---

## 5. Chaos engineering — the one discipline in this phase that's genuinely been exercised for real

Unlike load testing, this one has real, dated, measured results — already covered in depth in
Phase 2 Lab 2.4 and referenced throughout this curriculum, restated here specifically through the
master plan's own methodology: **hypothesis → inject → observe → fix.**

**Drill 1 (checkout atomicity):**
- *Hypothesis:* if Postgres dies mid-transaction during `placeOrder()`, nothing partial survives.
- *Inject:* a deliberate lock-based stall (not a race against a fast transaction — Phase 2 Lab
  2.4's own reasoning for why a naive version of this test would be a lie), then
  `pg_terminate_backend()` on the stalled connection.
- *Observe:* real, dated 2026-08-13 output — zero orders created, cart still `ACTIVE`, zero
  orphaned reservations.
- *Fix:* none needed — the hypothesis held. **Worth noting precisely: chaos engineering's value
  isn't only "found a bug, fixed it" — confirming a hypothesis holds, with real evidence, is
  itself the successful outcome**, and this drill's own documentation is honest about an actual
  false-negative it hit on a *first* run (stray rows from earlier manual `psql` surgery, not the
  drill's own bug) rather than only reporting the clean final result.

**Drill 2 (worker `SIGKILL` mid-tick):**
- *Hypothesis:* a worker killed with zero warning mid-batch resumes cleanly, with no double-
  processing or corruption.
- *Inject:* `SIGKILL` (not `SIGTERM` — no graceful-shutdown chance) sent 150ms after boot,
  confirmed to land genuinely mid-tick.
- *Observe:* real, dated results — 18 of 40 intents at `pollAttempts=1`, 22 untouched, zero
  corrupted rows; after restart, the 18 correctly waited out their backoff window rather than being
  immediately (and wrongly) reprocessed as duplicates.
- *Fix:* none needed — same outcome as Drill 1.

**What's honestly still missing, in the chaos runbook's own words, restated for this phase:**
*"Are these drills actually scheduled, or did they happen once because a codebase was being built
and are now just... here? Being honest: right now it's the latter."* A single well-executed drill
and a genuinely recurring practice are different levels of maturity — this codebase has reached the
first, honestly, and named the second as unfinished rather than implying otherwise.

---

## 6. Disaster recovery — a real, executed drill, with its own remarkably honest scope boundary

`docs/runbooks/05-backup-restore-drill.md` documents a real `pg_dump`/`pg_restore` cycle, run for
real, verifying not just that data loads but that constraint enforcement survives the restore (an
easy thing to skip checking — a restore that loads rows but silently drops a `CHECK` constraint or
`@@unique` index looks successful until the exact moment that missing constraint would have
mattered).

**What makes this runbook worth reading in full is its own "What this drill does NOT cover" section
— naming four real gaps, each with the specific reason it matters, rather than declaring victory
after one successful restore:**

- **RTO/RPO measurement** — *"This drill proves correctness of a restore, not how long one takes
  under a realistic production data volume."* This project has never stated an actual RTO
  (Recovery Time Objective — how long an outage is tolerable) or RPO (Recovery Point Objective —
  how much data loss, measured in time-since-last-backup, is tolerable) as real numbers, because
  neither has been measured against production-scale data.
- **Point-in-time recovery** — *"`pg_dump` is a snapshot... it cannot recover to 'just before the
  bad migration at 14:32,' only to whenever the last dump happened."* Real PITR needs WAL
  archiving, which this project has not set up.
- **Cross-region/provider-outage recovery** — *"This drill restored on the same host. A real DR
  posture needs the backup itself stored somewhere that survives the primary region being down."*
  Directly downstream of Phase 7 §0's finding: no infrastructure-provisioning code exists to even
  specify a region, let alone a second one.
- **The application's own recovery, not just the database's** — *"A restored database with a stale
  snapshot means the worker's reconciler has real work to do the moment the app reconnects...
  Confirm the reconciler sweep actually catches up after a real restore, not just that the data
  loaded."* This is the one gap that connects directly back to this curriculum's own central
  architecture (Phase 1 §8's webhook/poller/reconciler triple) — the runbook is pointing out that
  restoring a database is necessary but not sufficient; the *application* also has to be verified
  to correctly reconcile the gap between "what the stale backup shows" and "what actually happened
  at SantimPay while the backup was stale," which has never itself been drilled.

**Multi-AZ** isn't addressed at all, for the same root reason as cross-region recovery — it's an
infrastructure-provisioning decision, and Phase 7 §0 already established none has been made.

---

## 7. Capacity planning and cost per order — the one section with nothing to cite

Consistent with Phase 7 §5's own reasoning, restated because it applies identically here: computing
a real cost-per-order figure requires real traffic data (order volume, actual infrastructure spend)
this project has never had, since it has never served real production traffic. Inventing a number
here would be exactly the dishonest move this curriculum has avoided in every phase that hit this
same limit. **What's real and stated instead:** `deployment-web.yaml`'s actual resource
requests (Phase 8 §6 — `250m` CPU, `384Mi` memory per pod, `Burstable` QoS) are the one concrete,
per-pod cost input this codebase has an honest number for; multiplying that by a real cloud
provider's per-vCPU/per-GB pricing and this project's actual (currently unmeasured) order volume
is the calculation capacity planning ultimately requires — the inputs on one side of that equation
exist; the inputs on the other side don't yet.

---

## Labs

### Lab 11.1 — Actually find the knee

Run `browsing.js` (or a purpose-built ramping scenario) with a deliberately escalating VU count far
past what the current threshold table was calibrated against, watching p95/p99 latency and error
rate at each step rather than just the final summary. Identify the actual point where latency stops
scaling linearly with load — the knee the master plan names and this phase's own §4.2 found nobody
had located yet. Record it, the same way the chaos drills recorded real dated results rather than
leaving the finding implicit.

### Lab 11.2 — Reproduce the connection-pool gap §2 named

Scale `deployment-web` to its HPA maximum (12 replicas, Phase 8 §9) against a Postgres instance
configured with a deliberately low `max_connections` (low enough that 12 independent Prisma pools
could plausibly exceed it). Generate real concurrent load and confirm whether you can reproduce
"too many clients already" — the exact error `db.ts`'s own comment names, but in the production
multi-replica scenario that comment doesn't address, rather than the dev-mode hot-reload scenario
it does. If you can reproduce it, that's the concrete case for PgBouncer this phase otherwise only
argued for in the abstract.

### Lab 11.3 — Build a real dead-letter path

Give `OutboxMessage` (or a new, explicit `dead_letter_messages` table) a genuine DLQ mechanism:
after `attempts` crosses a threshold (the existing comment's own "~10" is a reasonable start),
move the row to a distinct state a normal `publishOutbox()` tick never picks up again, and add the
automated alert Phase 9 §5 already described but this codebase doesn't yet have. Then write the
actual "drain the DLQ" procedure the master plan asks for — inspect each stuck message, decide
retry-as-is versus manual intervention versus permanent discard, and document it as a seventh real
runbook alongside the six that already exist.

### Lab 11.4 — Drill the gap the backup-restore runbook already named

Pick the fourth item from §6's list — the application's own recovery, not just the database's.
Restore a deliberately-stale backup (taken, then let several real payment state transitions happen
against the *live* system before restoring), reconnect the app, and confirm — with real
measurements, not assumption — that the reconciler's sweep actually catches every payment that
resolved during the gap. This is the one DR gap this project's own documentation already flagged as
undrilled; this lab is that missing drill.

---

## Gate — do not proceed to Phase 12 until you can do this cold

1. **This project's load-test thresholds are explicitly calibrated for a system with no caching
   layer. What's the actual, concrete risk of leaving them uncalibrated once caching is added?**
   (They'd stay looser than necessary — a real regression could pass a threshold that was only ever
   generous because it assumed every request hits Postgres directly; the thresholds need
   re-tightening once the assumption they were written against changes, not left as-is
   indefinitely.)
2. **Why is `db.ts`'s `globalThis`-cached Prisma client not a solution to the connection-pool
   question a 12-replica production deployment actually raises?** (It solves a single-process,
   dev-mode, hot-reload problem — one pool per process instead of one per edit. It says nothing
   about whether N independent replicas' pools collectively exceed Postgres's own connection
   limit under real concurrent production load, a question this codebase has never tested.)
3. **This codebase's outbox retry mechanism is not a formal dead-letter queue. Name the specific
   difference.** (A real DLQ moves an exhausted message to a distinct destination with its own
   automated visibility; this codebase's failing rows just keep retrying on an ever-longer capped
   backoff forever, relying on a human remembering to run a manual query — intent stated in a
   comment, not an actual mechanism.)
4. **Explain, precisely, why chaos engineering has been genuinely exercised in this codebase while
   load testing has not, even though both have real, ready tooling.** (The chaos drills were
   actually *run*, with real dated 2026-08-13 results recorded; the k6 scripts exist and are
   real, but no baseline run — let alone a deliberate knee-finding run — has ever actually
   happened and had its results recorded anywhere in this codebase.)
5. **The backup/restore runbook names four things it does NOT cover. Pick one and explain why
   listing it honestly is more valuable than a runbook that implies full DR coverage after one
   successful restore.** (E.g., application-level recovery — without naming it, a team might
   reasonably believe "we tested our backups" covers the whole recovery story, when the actual
   remaining risk — the reconciler correctly catching up after a stale restore — has never been
   verified at all.)

---

*Next: `12-integration-breadth.md` — Phase 12: what this curriculum's deep, single-integration
focus on SantimPay didn't teach — the patterns that only show up once you've integrated a second,
third, and fourth external system with genuinely different failure modes.*
