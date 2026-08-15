# Phase 1 — Integration Fundamentals

*Every concept below is illustrated with a real file from `santim-commerce`, not a toy example.
Open the referenced file alongside this document — that pairing is the whole teaching method
here. Where a claim is testable, the file path to the test that proves it is given too.*

---

## Why this phase exists before any code

Phase 0 taught you how a request reaches a server. This phase teaches you what's actually hard
about integration: **two systems that were designed separately have to agree about reality,
across a network that lies to you, forever.** Every bug you will ever debug in an integration is
a variation on that sentence. Learn the theory once, here, and you will recognize it in every
gateway, every webhook, every "why did this get charged twice" ticket for the rest of your
career.

---

## 1. The eight fallacies of distributed computing

A list from the 1990s (Peter Deutsch, L. Peter Deutsch and James Gosling at Sun) that has not
aged a day, because the physics hasn't changed:

1. The network is reliable.
2. Latency is zero.
3. Bandwidth is infinite.
4. The network is secure.
5. Topology doesn't change.
6. There is one administrator.
7. Transport cost is zero.
8. The network is homogeneous.

Every one of these is false, and SantimPay's integration is a compact demonstration of exactly
how expensive believing them is:

| Fallacy | Where it bites in this codebase |
|---|---|
| The network is reliable | `packages/santimpay/src/http.ts` exists entirely because it isn't — bounded retries with jitter, because a request to `services.santimpay.com` can simply fail |
| Latency is zero | `SantimPayClient`'s default 15-second timeout (`client.ts`) — a Telebirr confirmation can take seconds to low-single-digit minutes, not milliseconds |
| The network is secure | `webhook.ts`'s entire existence — an inbound POST claiming to be SantimPay must prove it cryptographically, because the network between them and you is not trusted |
| Topology doesn't change | `docs/01-santimpay-protocol-spec.md` §3 has testbed and production as *different URLs* — the "topology" of which servers you talk to changes by environment, and code that hardcodes one breaks in the other |

**The one that costs the most money, specifically for payments:** latency isn't zero, so **you
cannot know, at the moment a request times out, whether the money moved or not.** Read that
again — it is the single most important sentence in this entire curriculum. A timeout is not a
failure signal. It is an *unknown* signal. Everything in Phase 2 exists to resolve that unknown
without ever guessing.

---

## 2. Delivery semantics — what "sent" actually means

Three levels, and only one of them is achievable in practice:

| Semantic | What it guarantees | Achievable? |
|---|---|---|
| **At-most-once** | A message is delivered zero or one times — never duplicated | Trivial (just don't retry), but means you silently drop messages on failure. Never acceptable for payments. |
| **At-least-once** | A message is delivered one or more times — never lost | Achievable, and what every real system (including SantimPay's webhooks) actually gives you |
| **Exactly-once** | A message is delivered precisely once | **Not achievable at the transport layer, full stop.** No amount of engineering makes a network guarantee this. |

If exactly-once delivery is impossible, how does every payment in this codebase get processed
exactly once? **By decoupling delivery from effect.** You accept that a message might arrive
twice (at-least-once is what you actually get) and make processing it twice produce the same
result as processing it once. That property has a name: **idempotency**. It is the entire answer
to the "exactly-once" problem, and it's a property of your *code*, not of the network.

**Worked example:** `docs/01-santimpay-protocol-spec.md` §5.3 states this explicitly as one of
the webhook handling rules — *"Gateways retry; assume at-least-once delivery, always"* — and the
mechanism enforcing it is a **database unique constraint**, not an in-memory flag:

```prisma
// apps/web/prisma/schema.prisma
model WebhookEvent {
  ...
  @@unique([provider, gatewayTxnId, status])
}
```

A second delivery of the identical callback hits that constraint, `payment-service.ts` catches
the `P2002` violation, and returns the same "recorded" response — no duplicate processing, no
error visible to SantimPay. **Why a database constraint and not an in-memory `Set` of seen IDs?**
Because an in-memory set doesn't survive a restart, and doesn't work at all once you run more
than one replica (see `infra/k8s/base/deployment-web.yaml` — 3 replicas by default). The
constraint is enforced by the one thing all replicas actually share: the database.

---

## 3. Idempotency, in depth

Idempotency means: **calling an operation N times has the same effect as calling it once.**
There are three common mechanisms, and this codebase uses all three, deliberately, in different
places:

### 3.1 Natural keys

If the data itself has a naturally unique identity, use it. `webhook_events`'s unique constraint
above uses SantimPay's own `gatewayTxnId` — a key SantimPay assigns, not one we invent. No
coordination needed; the identity is inherent to the data.

### 3.2 Idempotency keys (client-generated)

When there's no natural key — you're the one *initiating* an action — you generate one, once,
and persist it *before* the network call. `apps/web/src/server/payments/payment-service.ts`'s
`startPayment()`:

```ts
const merchantTxnId = ulid();          // generated once
await prisma.paymentIntent.create({    // persisted BEFORE the outbound call
  data: { merchantTxnId, status: "CREATED", ... },
});
// only now, call SantimPay
const { paymentUrl } = await santimpay().createCheckoutSession({ transactionId: merchantTxnId, ... });
```

**The ordering is the entire lesson.** If you called SantimPay first and persisted second, a
crash between those two steps would charge a customer for an order your database has no record
of — the single worst failure mode in commerce, and one that's *invisible* until a customer
complains. Persist first. The write to your own database is the operation you can make reliable;
the network call to a third party is the one you can't.

SantimPay's own protocol *requires* this pattern, and documents the failure mode explicitly:
reusing a `merchantTxnId` returns `"Duplicate Client Reference."` — see
`packages/santimpay/src/errors.ts`'s `DuplicateReferenceError`, which is deliberately a
**different exception type** from a generic failure, because a duplicate reference means "this
might have already succeeded," not "this failed" — see `payment-service.ts`'s handling of it,
which resolves by *asking* (`settlePayment`), never by assuming.

### 3.3 Conditional writes (the database as the enforcement point)

The idempotency key only works if something actually *rejects* the second attempt. That
something should almost always be a **unique constraint**, not an application-level check —
because a check-then-write in application code has a race condition baked into its name.

**Worked example — the exact same principle applied to a completely different problem:**
`apps/web/src/server/inventory/reservation.ts` prevents overselling not by checking stock then
writing, but with one atomic conditional UPDATE:

```sql
UPDATE "inventory"
   SET "reserved" = "reserved" + $quantity
 WHERE "variantId" = $variantId
   AND ("allowBackorder" = TRUE OR ("onHand" - "reserved") >= $quantity)
```

(Quoted, camelCase columns — Prisma doesn't snake_case column names by default, and an unquoted
identifier gets folded to lowercase by Postgres and silently misses. The file's own comment on
this line is worth reading verbatim; it's exactly the kind of easy-to-miss detail that costs an
hour the first time you hit it.)

This *is* an idempotency/concurrency-safety technique in the same family as the webhook unique
constraint — "let the database's own locking be the enforcement point, not a race between a read
and a write in your process." It is proven — not asserted, *proven*, with a real concurrent test
against real Postgres — in
`apps/web/src/server/inventory/reservation.integration.test.ts`: 200 concurrent buyers racing 1
unit of stock resolves to exactly 1 sale.

**Lab 1.1 for this concept is below — you'll build this exact pattern from scratch.**

---

## 4. The dual-write problem

You cannot atomically write to your own database **and** call an external API. There is no
transaction that spans both — Postgres has no idea SantimPay exists, and vice versa. This is
called the dual-write problem, and it is unavoidable any time your system needs "update my state"
and "tell someone else about it" to both happen.

Two accepted solutions:

**1. Order the writes so the unsafe half is retriable.** This is what `startPayment()` does —
the database write happens first and is the source of truth; the external call is *initiated
from* that persisted state, so a crash after the DB write but before (or during) the SantimPay
call leaves a `PaymentIntent` row in `CREATED` status that the reconciler will find and retry.
The dual write isn't made atomic — it's made *safe to redo*.

**2. The transactional outbox pattern.** Write your state change and a "message to send" row in
the **same database transaction**, then have a separate process publish outbox rows. This
codebase uses this exact pattern for side effects that aren't payment-critical:

```prisma
model OutboxMessage {
  id          String   @id @default(cuid())
  topic       String
  payload     Json
  publishedAt DateTime?
  ...
}
```

See `apps/web/src/server/payments/payment-service.ts`'s `applyPaymentTransition()` — when a
payment completes, `enqueue(tx, "order.paid", {...})` writes the outbox row **inside the same
`$transaction()`** as the order-status update. `apps/web/src/worker/index.ts`'s
`publishOutbox()` then delivers it later, with its own retry/backoff. If the process crashes
between the transaction committing and the outbox message being published, the message is still
there — it isn't lost, because it was never something separate from the state change, it was
part of it.

**Why not use the outbox for the SantimPay call itself?** Because `createCheckoutSession()`
needs to return a URL to redirect the customer to, synchronously, in the same request — an outbox
is for *fire-and-forget* side effects (send an email, reindex search), not for a call whose
result the current request needs.

---

## 5. State machines over boolean flags

A `Boolean paid` field can express exactly two states. Reality has more: created, pending,
completed, failed, declined, expired, refunded. The moment you reach for a *second* boolean
(`paid` and `refunded` and `cancelled`...) to cover the gap, you've built an implicit state
machine with none of the safety of an explicit one — nothing stops `paid=true` and
`refunded=true` and `cancelled=true` all being set simultaneously, a state that makes no sense
but that nothing in a pile of booleans prevents.

**Worked example:** `apps/web/src/server/orders/state-machine.ts` declares every legal
transition explicitly:

```ts
const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["PENDING", "COMPLETED", "FAILED", "DECLINED", "EXPIRED"],
  PENDING: ["COMPLETED", "FAILED", "DECLINED", "EXPIRED"],
  COMPLETED: ["REFUNDED"],       // terminal, with one exit
  FAILED: [],                     // terminal, no exit
  ...
};
```

**The bug this exists to prevent, specifically:** a Telebirr confirmation is slow. A `PENDING`
webhook can be delivered, get delayed by a flaky mobile network, and arrive **after** a
`COMPLETED` webhook that resolved faster through a different path (the poller, say). Without an
explicit state machine, whichever update runs last wins — and if that's the late `PENDING`, you
have just **un-paid a paid order**, and the warehouse never ships. With the state machine,
`COMPLETED → PENDING` is not in the allowed-transitions list, so `decidePaymentTransition()`
returns `{ action: "ignore", reason: "terminal" }` instead of applying it. This exact scenario is
a named unit test:
`apps/web/src/server/orders/state-machine.test.ts` — *"a completed payment can never go back to
pending."* Run it. Then delete the state machine's guard and watch it fail. That's the fastest
way to feel why this matters.

**A subtlety worth sitting with:** notice `EXPIRED: ["COMPLETED", "FAILED"]` — an expired payment
can *still* complete. Why would you allow that? Because your poll timeout is *your* deadline, not
SantimPay's. The gateway doesn't know you gave up waiting, and a channel can resolve 45 minutes
late. If `EXPIRED` were truly terminal, that late-resolving payment would leave a customer
charged with no order ever fulfilled — silently, forever. The state machine encodes a business
decision, not just a technical one: which transitions being "impossible" would actually cause
harm if they *did* happen.

---

## 6. The anti-corruption layer

A third party's vocabulary will leak into your domain model if you let it, and the moment it
does, every change on their side becomes a landmine on yours.

**Worked example, and a genuinely embarrassing one if you don't have this layer:** SantimPay
reports payment success as `"COMPLETED"` for a standard payment but `"SUCCESS"` for a B2C payout
— two different words for the identical concept of "the money moved." A raw Postgres constraint
violation (`chk_santimpay_wallets_balance_is_non_negative`) leaks straight through their API as
an error *message* when a payout exceeds escrow balance.

`packages/santimpay/src/types.ts`'s `normalizeStatus()` collapses both success words into one
domain value:

```ts
switch (String(wire).toUpperCase()) {
  case "COMPLETED":
  case "SUCCESS":
    return "COMPLETED";
  ...
}
```

And `packages/santimpay/src/errors.ts`'s `classifyDecline()` translates the raw, ugly,
implementation-detail-leaking Postgres error into a stable code your application logic can
actually branch on:

```ts
if (m.includes("chk_santimpay_wallets_balance_is_non_negative")) {
  return "INSUFFICIENT_MERCHANT_BALANCE";
}
```

**The test this deserves, and has:** `packages/santimpay/test/client.test.ts`'s *"every
documented decline message maps to a stable code"* — proving the translation layer covers every
error the protocol spec documents, not just the ones that happened to come up in manual testing.

**The rule to take away:** the moment a vendor's exact string, exact field name, or exact status
code appears in your business logic (a `checkout-service.ts` that does
`if (transaction.raw.status === "COMPLETED")`), you have skipped the anti-corruption layer. The
tell is always the same: your domain code should never need to know what a third party calls
something, only what *you* call it.

---

## 7. Retry theory

Retrying a failed request seems obvious until you retry it wrong, at which point you can turn a
brief blip into an outage. Four concepts, in order of how often people get them wrong:

### 7.1 Exponential backoff with full jitter

Doubling the delay between attempts (exponential backoff) is well known. What's less well known:
**fixed backoff creates a thundering herd.** If every client that failed at the same instant
retries after exactly the same delay, they all hit the recovering service at the same instant
again — this is *why* retry storms happen, not despite backoff but because of naive backoff.

`packages/santimpay/src/http.ts`'s `backoffDelay()` uses "full jitter" (from the AWS
Architecture Blog — a real, citable source, not folklore):

```ts
export function backoffDelay(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);   // random WITHIN the whole interval, not a fixed point
}
```

Randomizing the *entire* interval, not just adding noise to a fixed point, is what spreads
retrying clients out instead of clustering them.

### 7.2 Retry budgets — not everything should be retried

`packages/santimpay/src/http.ts`'s retry logic checks `err.retryable` before ever attempting a
second call:

```ts
const retryable = err instanceof SantimPayNetworkError
  || err instanceof SantimPayTimeoutError
  || (err instanceof SantimPayHttpError && err.retryable);   // 5xx/429 only
```

A 4xx response means the request itself was wrong — retrying an identical malformed request
produces an identical failure, forever, while burning your retry budget and the gateway's
patience. **This is proven, not assumed:** `packages/santimpay/test/client.test.ts`'s *"a 4xx is
not retried"* asserts exactly one call was made, and *"transient 5xx is retried and then
succeeds"* asserts the retry path actually recovers.

### 7.3 Deadlines — a retry loop needs an exit

Retrying forever is not resilience, it's a resource leak wearing resilience's clothes. Every
outbound call in this codebase has a deadline (`SantimPayConfig.timeoutMs`, default 15s) *and* a
bounded retry count (`DEFAULT_RETRY.maxRetries = 2`). **The critical detail people miss:** a
timeout is not "the request failed." It's "I stopped waiting to find out." SantimPayTimeoutError's
message says so explicitly: *"the request may still have been processed upstream — reconcile, do
not assume failure."* This is the same unknown-signal problem from §1, showing up again at the
transport layer specifically.

### 7.4 Circuit breakers and bulkheads (introduced here, built in the lab)

A retry loop protects *you* from a flaky call. A circuit breaker protects the *dependency* from
being hammered by retries while it's already struggling — after N consecutive failures, stop
calling entirely for a cooldown period, then send one "probe" request to check recovery before
resuming normally (the classic closed → open → half-open → closed cycle). A bulkhead limits how
much of your own capacity (threads, connections) one dependency can consume, so a struggling
payment gateway can't also take down your ability to serve the product catalogue. Neither is
implemented in this codebase yet — SantimPay is the only external dependency, and at this scale a
circuit breaker would be premature. **Lab 1.3 builds one anyway, because recognizing when you
*don't* need a pattern is easier once you've built it once and felt what it does.**

---

## 8. Webhooks vs. polling vs. reconciliation — why mature systems run all three

A webhook-only integration WILL leak stuck orders. Not "might" — will. Callbacks get dropped by
proxies, blocked by a misconfigured WAF, or simply lost during a gateway-side incident. This
isn't pessimism, it's what actually happens on real networks, especially Ethiopian mobile
networks specifically, which is why this project treats it as a certainty rather than an edge
case.

`apps/web/src/worker/index.ts`'s module comment states the architecture directly:

```
webhook  ──┐
poller   ──┼──▶ settlePayment(merchantTxnId) ──▶ status API ──▶ txn commit
reconciler─┘
```

Three independent triggers, **one decision path**. This is the single most important
architectural idea in the whole codebase, so it's worth being explicit about why each layer
exists and what it alone would miss:

| Layer | Catches | Misses |
|---|---|---|
| **Webhook** | The fast path — usually resolves in seconds | Anything dropped in transit; SantimPay-side delivery failures |
| **Poller** (backoff 5s→10s→...→900s, ~50min total window — see `nextPollDelaySeconds`) | Webhooks that never arrive, within the poll window | Anything that resolves after ~50 minutes |
| **Reconciler** (hourly sweep of everything non-terminal) | Everything else, including payments that resolve hours late | Nothing, by design — it's the backstop under the backstop |

**Why not "just" the reconciler, running every 30 seconds, and skip the webhook/poller
complexity?** Customer experience. A customer standing at a Telebirr prompt wants their
confirmation page to update in *seconds*, not up to an hour later. The layered design isn't
redundancy for its own sake — the webhook optimizes for speed, the poller bridges the gap when
speed fails, and the reconciler guarantees correctness even when both fail. **Speed and
correctness are different requirements, met by different mechanisms, on purpose.**

**And the part every layer must agree on:** none of the three trust their own trigger as proof of
truth. `payment-service.ts`'s `settlePayment()` is the *only* function that decides state, and it
does so by calling `fetchTransactionStatus()` — the Transaction Status API — regardless of which
of the three triggers called it. The webhook body is never trusted directly; it only tells you
*to go check*.

---

## 9. Contract testing — why mocks lie

A unit test that mocks SantimPay's API tests *your assumption* about what SantimPay does, not
what SantimPay actually does. If your assumption is wrong — a field renamed, a status value you
didn't know about, a response shape that changed — the mock happily agrees with you while
production breaks.

This codebase's answer isn't formal consumer-driven contract testing (Pact, or similar) — that's
worth adopting the moment you have more than one team or more than one API version to track — but
the same *principle* shows up twice, worth recognizing as the same idea:

1. **The integration tests use a real Postgres, never a mocked Prisma client** — see
   `reservation.integration.test.ts`'s own module comment: *"A mocked Prisma client cannot prove
   this — mocks do not have Postgres's row-locking behaviour, which is the entire mechanism the
   code relies on."* A mock of the database would have to correctly reimplement Postgres's MVCC
   locking to be trustworthy here, at which point you've built a second, unverified database
   engine instead of testing against the real one.
2. **The webhook fixtures for load testing are pre-signed with the SDK's own real signing
   code**, not hand-crafted JSON pretending to have a valid signature — see
   `apps/web/scripts/generate-webhook-fixtures.ts`'s own header comment on why: *"every payload k6
   sends is a genuinely valid signature, not an approximation."*

**The rule, generalized:** the more security- or correctness-critical a piece of behavior is
(cryptographic signing, transaction isolation, concurrent locking), the *less* acceptable it is
to test against a hand-rolled approximation of it. Mock the parts that are slow or expensive to
run for real (an actual SantimPay API call in a unit test loop); never mock the part whose exact
behavior *is* the thing you're trying to prove correct.

---

## 10. Versioning and deprecation

Not deeply exercised in this codebase yet — SantimPay's API has one version, and this project
controls both ends of its own internal APIs — but the principle is worth stating because you will
hit it the moment you integrate a second gateway, or SantimPay ships a v2:

- **URL versioning** (`/api/v1/gateway/...`, which is what SantimPay actually uses) is explicit
  and cache-friendly, at the cost of URLs multiplying per version.
- **Header versioning** (`Accept: application/vnd.santimpay.v2+json`) keeps URLs stable but is
  easy to forget and harder to test by just pasting a URL in a browser.
- **Expand-contract** is the migration *strategy*, independent of which versioning scheme you
  use: add the new field/endpoint alongside the old one (expand), migrate every consumer over,
  *then* remove the old one (contract) — never a single atomic cutover. This exact strategy is
  named directly in `infra/k8s/base/job-migrate.yaml`'s comment on the migration Job:
  *"expand-contract migrations: this Job assumes migrations are additive/safe to apply before the
  new code is serving traffic, never a destructive change applied alongside it."* Same idea,
  applied to a database schema instead of an external API — versioning discipline isn't just an
  API concept, it's how you change anything safely underneath live traffic.

---

## Labs

Each lab pairs with a section above. **Do not read the solution before attempting it** — the
value is in hitting the failure mode yourself first.

### Lab 1.1 — Build an idempotent endpoint

Build a `POST /charge` endpoint that, given the same idempotency key twice, charges exactly once
and returns the *same* response body both times.

1. First pass: check-then-insert (`SELECT` for an existing key, then `INSERT` if absent). Hammer
   it with 50 concurrent identical requests using a tool like `autocannon` or a simple
   `Promise.all` loop. Count how many charges actually happened. It will be more than one.
2. Fix it: add a unique constraint on the idempotency key column, and make the insert the thing
   that fails safely on collision — catch the constraint violation and return the *original*
   response instead of erroring. Re-run the same 50-concurrent-request hammer. Exactly one
   charge.
3. Compare your fix against `apps/web/src/app/api/webhooks/santimpay/route.ts` +
   `payment-service.ts`'s `recordWebhook()` — same pattern, applied to inbound webhooks instead
   of outbound charges.

### Lab 1.2 — Implement a transactional outbox

Write an "order placed" row and an "outbox: send confirmation email" row in one transaction. Have
a separate poller process publish outbox rows (print "email sent" is a fine stand-in for an
actual email). Kill the poller process mid-publish (`kill -9`, not `SIGTERM` — no graceful
chance) and restart it. Prove: no message lost, none duplicated *in effect* (the poller may retry
a send, but your "email sent" log should reflect the outbox's own idempotent handling, not send
the same email twice unboundedly).

Compare against `apps/web/src/worker/index.ts`'s `publishOutbox()` — note its comment on
exponential backoff for failed deliveries, capped at 30 minutes, and think about why an
*unbounded* backoff would eventually make a permanently-broken delivery invisible.

### Lab 1.3 — Circuit breaker

Wrap a deliberately flaky dependency (a function that fails 80% of the time, or randomly sleeps
for 5 seconds) in a circuit breaker: open after N consecutive failures, refuse calls immediately
while open (no waiting for the flaky dependency's own timeout), half-open after a cooldown to
probe with one request, close again on success.

Chart p50/p95/p99 latency of calls made *through* the breaker, with and without it, while the
dependency is failing. The breaker should show a dramatically better p99 while open (failing
instantly instead of waiting out each call's full timeout) at the cost of a worse p50 while
healthy (a tiny bit of bookkeeping overhead). That tradeoff — sacrificing a little steady-state
performance for a much better worst case — is the entire point of the pattern, and is worth being
able to say out loud, not just implement.

---

## Gate — do not proceed to Phase 2 until you can do this cold

Given any third-party API you've never seen before, produce a one-page integration design
covering:

1. **Idempotency** — what's the natural key, or do you need to generate one? Where does the
   uniqueness get *enforced* (a database constraint, not a check-then-write)?
2. **Failure modes** — network failure, timeout, 4xx, 5xx, and the third party's own documented
   business-decline responses. Which are retryable? Which need a human?
3. **Delivery mechanism** — is there a webhook? If so, what's the plan for when it doesn't
   arrive? (If your answer is "it always arrives," you have not internalized §8.)
4. **State model** — draw the state machine. If any state has no legal exit and that seems wrong,
   you've found a bug before writing a line of code.
5. **Anti-corruption boundary** — name the one file that will be the only place in your codebase
   that imports this third party's SDK or knows its field names.

Write this *before* looking at their SDK's example code. Then look at their example code and see
how many of these five questions it silently gets wrong — vendor SDKs consistently skip
idempotency, retry policy, and state modeling, because they're optimizing for "works in a demo,"
not "works at 2am during an incident." You now know the difference.

---

*Next: `02-the-payment-core.md` — Phase 2 in depth: money as integer minor units, the redirect-is-
not-proof rule, and reconciliation as a first-class feature, all worked through the SantimPay
integration this curriculum is built around.*
