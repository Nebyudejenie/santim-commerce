# Phase 12 — Integration Breadth

*Same method as Phases 1–11 wherever real code exists to cite — but this phase's own premise, in
the master plan's own words, is different: "prove the theory generalises. Add, to the same
platform." None of the nine integration categories below exist in this codebase. What does exist,
and is the actual subject of this phase, is that several of them have a deliberately-built seam
already waiting — comments written by whoever built this codebase, anticipating exactly this
exercise.*

---

## Why this phase exists

Eleven phases have gone deep on one integration — SantimPay — because depth is how you actually
learn the failure modes that matter (a shallow tour of ten APIs teaches you their field names, not
what breaks). This phase is the payoff for that depth: every pattern proven against SantimPay —
idempotency, the anti-corruption layer, the outbox, retry-with-jitter, webhook+poll+reconcile — is
either directly reusable or informatively *not* reusable against a genuinely different integration
shape, and telling those two cases apart is the actual skill this phase is testing.

---

## 1. The seams this codebase already left for you, on purpose

Two real comments, already quoted in Phase 3, worth reading again with this phase's framing:

```ts
// shipping-service.ts
/**
 * SWAPPING THIS FOR A REAL CARRIER LATER: this module's public surface
 * (`calculateShipping`) is the only thing checkout-service.ts calls. A real
 * carrier integration replaces this file's body with a rated-shipment API
 * call and keeps the same function signature — same pattern as
 * @santim/santimpay being the one file that knows the payment gateway exists.
 */
```

```ts
// tax-service.ts
/**
 * WHAT THIS DOES NOT HANDLE, on purpose, and how to extend it correctly:
 *   - Zero-rated / exempt goods (a real requirement the moment the catalogue
 *     grows past apparel) — add a `taxCategory` to Variant and branch on it
 *     here; do not special-case product slugs inline.
 */
```

And a third, easy to miss, sitting in the worker's outbox publisher:

```ts
/** Replace with real senders (email, SMS, search reindex) as you build them. */
async function deliver(topic: string, payload: unknown): Promise<void> {
  logger.info("outbox.delivered", { topic, payload });
}
```

**That one comment names two of this phase's nine categories directly** — email/SMS and search —
and the mechanism it points at is already real and already proven: `payment-service.ts` already
writes `order.paid` and `order.payment_failed` rows into the *same* `OutboxMessage` table (Phase 1
§4) that a search-reindex or a transactional-email integration would consume from. The outbox
pattern isn't something Phase 12 introduces — it's something Phases 1–3 already built and proved,
sitting one `deliver()` case-branch away from doing real work.

---

## 2. Shipping/logistics — the seam is real; the failure modes are genuinely new

`calculateShipping()`'s replacement, per its own comment, keeps the same function signature and
swaps a flat-rate lookup for "a rated-shipment API call." **What's new here that SantimPay's
integration didn't teach:** a shipping API adds a *second* external dependency to the checkout
critical path, with its own timeout/retry/circuit-breaker needs (Phase 1 §7) — but unlike a
payment, a shipping *rate quote* is idempotent by nature (querying "what does this cost" twice
returns the same answer, no state changes), while *label generation* is not (generating two labels
for one order is a real, billable mistake, needing the exact idempotency-key discipline Phase 2 §3
built for `startPayment()`). **Tracking webhooks** are the closest direct analog to SantimPay's own
webhook — verify signature, persist before acting, never trust the payload as proof (Phase 2 §5) —
but with a materially different consequence for a missed one: a stuck payment blocks money; a
missed tracking update just shows a customer a stale status, a real but lower-severity failure that
would reasonably justify a *lighter* poll/reconcile cadence than the payment path's.

---

## 3. Tax — the seam is real; the correctness bar is the new part

`calculateTax()`'s extension comment already named the real next step (a `taxCategory` field, not
special-cased product slugs). **What a real tax-engine integration (Avalara, TaxJar, or an
Ethiopian equivalent) adds that this project's flat 15% VAT never had to handle:** jurisdiction
determination itself becomes a real API call with its own latency and failure mode, and — the
detail worth sitting with — *what do you charge when the tax engine is down at checkout time?*
Silently falling back to the flat rate is a real, defensible answer for some businesses and a real
compliance problem for others (Phase 10 §6's own reasoning about erasure requests applies here too:
this is a question with a legal answer, not just an engineering one). This is the sharpest example
in this whole phase of Phase 3 §5.1's own principle — *"an engineer correctly identifying the limit
of what engineering alone can answer"* — showing up again in a brand new integration.

---

## 4. ERP/accounting — genuinely the least like anything already built

Batch/file-based integration — SFTP drops, CSV/EDI, nightly reconciliation jobs — is a different
delivery paradigm than every real-time HTTP integration this curriculum has covered, and worth
naming the actual differences precisely rather than assuming the same patterns transfer unchanged:

- **No webhook equivalent exists.** A nightly file drop has no push notification — the closest
  analog isn't Phase 2's webhook, it's the *poller* half of that pattern alone: check on a
  schedule, ingest what's new, and — the genuinely new problem — **detect a file that never
  arrived**, which is a different failure mode than a webhook that never arrived, because there's
  no "poll SantimPay's status API" equivalent to fall back on. The absence of the file *is* the
  signal, and noticing an absence reliably is harder than noticing a presence.
- **Idempotency means something different for a file, not a request.** A CSV re-processed twice
  needs row-level idempotency keys *within the file* (an order number column, say) rather than a
  single request-level key the way `merchantTxnId` works — the same underlying idea (Phase 1 §3),
  applied at a different granularity because the unit of work changed from "one HTTP call" to "one
  file containing thousands of logical records."
- **"Retry" doesn't mean the same thing.** Retrying a malformed CSV unchanged produces the same
  malformed result forever (Phase 1 §7.2's 4xx-is-not-retryable lesson, generalized past HTTP status
  codes to "is this failure actually transient") — the real fix is almost always a human looking at
  the file, not an automated retry loop.

---

## 5. Search — the seam is real; sync strategy is the new decision

The outbox already carries `order.paid`; a search integration (Meilisearch, Elasticsearch) would
add `product.updated`/`product.created` events on the *catalogue* write path (which doesn't exist
yet in this project at all — Phase 3 §1 noted the catalogue has no admin write path currently,
only read queries) and consume them in `deliver()`. **The genuinely new question:** search index
sync is usually *eventually* consistent by design — a product edited this second being
searchable a few seconds later is normal and expected, unlike a payment whose eventual consistency
window (Phase 2 §6's ~49-minute poll window, backstopped by an hourly-ish reconciler) is treated as
an incident-worthy edge case, not the default. **The same outbox mechanism, two very different
tolerances for "eventually,"** is the actual lesson — the pattern transfers, the acceptable lag
does not.

---

## 6. Email/SMS — idempotency here means something a payment integration doesn't fully cover

The other half of `deliver()`'s own comment. Phase 1 Lab 1.2 already built the underlying
discipline (an outbox-driven email send, proven not to duplicate *in effect* even if the delivery
attempt itself retries) — the new wrinkle a real provider (SendGrid, Twilio) adds is **provider-side
idempotency keys**, which most transactional email/SMS APIs support explicitly for exactly this
reason: your own outbox retry might genuinely re-attempt a send whose first attempt actually
succeeded but whose success response was lost to a network failure (Phase 1 §1's timeout-is-not-
failure fallacy, showing up again) — without a provider-side idempotency key, that scenario means a
customer gets the same "your order shipped" email twice. **Delivery webhooks** (bounced, opened,
failed) are Phase 2's webhook pattern again, materially lower-stakes than a payment webhook, and a
good candidate for *not* building the same three-layer webhook+poll+reconcile defense-in-depth —
Phase 6 §3's own reasoning (match the sophistication of the response to the actual cost of getting
it wrong) applies here as directly as it did to deploy strategy.

---

## 7. Analytics — the failure mode that's easy to get backwards

"Server-side event pipeline, not just a browser pixel" is the master plan's own framing, and the
reason matters: a browser pixel is invisible to an ad-blocker's failure and silent about its own —
a dropped analytics event never pages anyone, which is usually fine for analytics specifically
*and exactly the property that makes it dangerous to build carelessly elsewhere*. The real lesson
this category teaches, once you've spent eleven phases on a system where every dropped event is a
genuine incident: **not every integration should get the reliability engineering this curriculum
spent so long building.** An analytics pipeline that queues events through the same
transactionally-safe outbox as a payment confirmation is arguably *over-engineered* — analytics
tolerates loss in a way this whole curriculum has spent its entire length arguing payments cannot.
Knowing when *not* to reach for idempotency keys, retries, and an outbox is the mirror image of
knowing when to.

---

## 8. AI — "just another integration," and where that framing holds and where it needs one caveat

The master plan's own framing: the Claude API (or any LLM API) is "just another integration with
the same rules — idempotency, timeouts, cost budgets, graceful degradation." Three of those four
transfer directly and completely:

- **Timeouts** — identical discipline to Phase 1 §7.3: an LLM call that hangs needs a deadline, and
  a timeout means "I stopped waiting," not "nothing happened" (the model may have generated a
  response that's now discarded, not "failed to generate one" — the same unknown-signal problem
  Phase 1 §1 called the most important sentence in this whole curriculum, verbatim, for a
  completely different kind of API).
- **Cost budgets** — a real, load-bearing concept an LLM API makes sharper than most integrations
  do: cost varies by token count, not just by call count, and a single pathological input (a
  customer support conversation an AI agent gets stuck looping on) can cost meaningfully more than
  a typical one — this needs the same kind of explicit, honest budget reasoning Phase 7 §5 and
  Phase 11 §7 both declined to invent numbers for, because a real budget depends on real, measured
  usage this project doesn't have.
- **Graceful degradation** — an AI recommendation widget or support agent that's unavailable should
  degrade to *no recommendations shown* or *a plain contact-support link*, never a broken page —
  directly the same principle as `/api/ready` (Phase 8 §8) pulling a pod from traffic without
  killing it: a failing dependency should narrow what's offered, not crash what already works.

**The one place "just another integration" needs a real caveat, worth being precise about rather
than eliding:** idempotency, in Phase 1 §3's sense, means "calling an operation N times has the
same effect as calling it once" — true and essential for a *payment*, and **not quite the right
frame for a non-deterministic generative call**, where the same prompt can legitimately produce a
different (not wrong, just different) response on a retry. The property you actually want for an
AI integration's retry path isn't "identical output" — it's closer to "an equivalently *acceptable*
output, and never a duplicated *side effect*" (don't send the same AI-drafted email twice; it's
fine if a retried draft reads slightly differently than the discarded first attempt). Recognizing
that this is a *related but distinct* property from Phase 1's original definition — not just
reapplying the same word to a case it doesn't cleanly fit — is itself the actual skill this section
is testing.

---

## 9. Message brokers, and iPaaS — patterns this curriculum deliberately didn't need

**Kafka/RabbitMQ**, event-driven choreography versus orchestration: this whole codebase is a real,
worked example of **orchestration** — `payment-service.ts`'s `settlePayment()` is a single function
every trigger (webhook, poller, reconciler) calls, making one authoritative decision (Phase 2's
own "one decision path" framing). **Choreography** — services independently reacting to events
with no central coordinator — is a genuinely different architecture, not just a different
transport, and this codebase's own outbox (Phase 1 §4) is *closer to* choreography's building
block than to a message broker's: an `OutboxMessage` row is a durable, ordered fact one consumer
(currently: the same worker process) reads, versus a broker's model of many independent consumers,
consumer groups, and partition-level ordering guarantees a single-table poll was never designed to
provide at real scale. **The honest reason this project doesn't need one:** at this system's
current real event volume (unmeasured, per Phase 11 §7 — but structurally, a handful of outbox
topics consumed by one worker process), a message broker would add real operational cost (another
stateful system to run, monitor, and back up) for a scaling problem this project doesn't have yet
— the same "say no and mean it" reasoning Phase 8 §11 already applied to a service mesh.

**iPaaS** (MuleSoft, Camel, an Enterprise Service Bus) exists to solve integration sprawl — dozens
of systems, inconsistent protocols, and a real organizational need for centralized transformation
and routing logic. A single application integrating with a handful of well-understood external
systems, each with its own anti-corruption layer already living in exactly one file
(`@santim/santimpay`'s own module, this phase's shipping/tax/search equivalents), **is the
condition under which iPaaS middleware is the wrong answer, not a smaller version of the right
one** — it would add a whole new platform's worth of indirection to solve a coordination problem
this codebase's own file-per-integration discipline already solves more simply. Recognizing *when
the sophisticated answer is the wrong one* is the same skill Phase 8 §11 and this section's message-
broker discussion both already exercised — worth noticing it's now shown up three times across two
phases, because that repetition is the actual point: mature engineering judgment says no far more
often than a curriculum's own breadth might make it feel like it should.

---

## Labs

Every lab below asks you to actually build one of these integrations against this real codebase —
this phase's own premise is that the theory should generalize in your hands, not just be readable
on the page.

### Lab 12.1 — Build the search integration for real

Add a minimal admin write path for `Product` (currently read-only, Phase 3 §1) that writes
`product.updated` to the outbox on save. Stand up a local Meilisearch instance, implement the
`search` case in `deliver()`, and confirm: editing a product's title in the (new) admin form makes
it findable under the new title within the outbox's own poll interval, with zero changes to
`payment-service.ts` or anything else already using the same table.

### Lab 12.2 — Build the shipping integration, and prove the idempotency split

Implement a real rate-quote call (a sandbox/test API from any real carrier, or a deliberately
flaky stand-in you build yourself) behind `calculateShipping()`'s existing signature. Then add
label generation as a *separate*, genuinely idempotent operation — generate an idempotency key at
checkout time the same way `merchantTxnId` is generated (Phase 2 §3.1), persist it before calling
the carrier, and prove — the same way Phase 3's reservation test proved oversell-prevention — that
retrying a label-generation request with the same key never produces two billable labels.

### Lab 12.3 — The AI integration, built around its one real difference from a payment

Add a support-message-drafting feature using a real LLM API. Implement the timeout and
graceful-degradation halves exactly like §8 describes. For the idempotency half, deliberately do
NOT require identical output on retry — instead, build the actual property that matters: generate
a client-side idempotency key per *send* action (not per generation), so a double-click on "send
draft" can safely re-trigger a generation without ever sending two messages, even though the two
generations' text may legitimately differ. Write down, in your own words, why this is the correct
adaptation of Phase 1 §3 rather than a violation of it.

### Lab 12.4 — Say no, and defend it in writing

Pick one of §9's two "this project doesn't need it" conclusions (message broker, iPaaS). Write the
one-page case *for* adopting it anyway, as if you were the engineer proposing it — real, specific
scale numbers (invented for the exercise, clearly labeled as such, unlike every other number this
curriculum declined to invent) at which the conclusion would flip. This is the direct completion of
Phase 7 §5's own exercise, applied to an architectural decision instead of a cost one: knowing
*where* your own reasoning would change is what separates a real judgment call from a fixed
opinion.

---

## Gate — do not proceed to the closing chapter until you can do this cold

1. **Name the one mechanism, already real and already proven in this codebase, that a search
   integration and an email/SMS integration would both build on — and what specific comment in
   this codebase already says so.** (The transactional outbox, `worker/index.ts`'s `deliver()`
   function — its own one-line comment names both "email, SMS" and "search reindex" as the
   intended replacement.)
2. **Why is a shipping *rate quote* naturally idempotent while *label generation* is not, and what
   does that difference require operationally?** (A rate quote is a pure query with no state
   change — asking twice costs nothing extra; a label is a real, billable side effect, needing the
   same generate-key-before-calling-the-vendor discipline Phase 2 §3.1 built for payments, or a
   double-click produces two chargeable labels.)
3. **Explain precisely why "idempotency" needs a different definition for a generative AI call than
   for a payment, without abandoning the concept entirely.** (A payment's idempotency means
   identical output on retry; a generative call's retry can legitimately produce different, still-
   acceptable output — what has to stay invariant is the *side effect* count, not the content, which
   is a related but genuinely distinct property from Phase 1 §3's original definition.)
4. **Why doesn't this project need a message broker at its current scale, and what would have to
   change for that answer to flip?** (Its real event volume today is a handful of outbox topics
   consumed by one process — a broker's operational cost, another stateful system to run and back
   up, isn't justified by a scaling problem that doesn't exist yet; it would flip once real
   consumer-group fanout or partition-level ordering guarantees became an actual requirement, not a
   hypothetical one.)
5. **This phase found the same underlying lesson — "the sophisticated answer is sometimes the
   wrong one" — showing up three separate times across two phases. Name all three instances.**
   (Phase 8 §11's service mesh, this phase's message-broker discussion, and this phase's iPaaS
   discussion — three genuinely different technologies, the identical reasoning each time: match
   the tool's complexity to a real, current need, not to how mature the option makes the system
   sound.)

---

*This is the last individually-written phase — the master plan itself (`00-MASTER-PLAN.md`) has no
Phase 13. Its own closing sections, "The daily rhythm that makes this stick" and "How you will know
you're an expert," are the curriculum's actual conclusion: six criteria, none of them "I know
Kubernetes" — reaching for a state machine before a boolean, asking "what happens if this is
delivered twice" reflexively, reading a dashboard and forming a hypothesis in under a minute,
writing the runbook before the incident, saying "we should not build this" with reasons, and
someone else being able to deploy, debug, and roll back this system without you, because it's
written down. Twelve phases of this codebase, read closely, are the evidence for whether that's
true yet.*
