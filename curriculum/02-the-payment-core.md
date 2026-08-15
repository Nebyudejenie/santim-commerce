# Phase 2 — The Payment Core

*Same method as Phase 1: every claim below is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. Where the codebase's own documentation
disagrees with its code, that disagreement is pointed out explicitly rather than smoothed over —
finding out docs can lie is itself part of the lesson.*

---

## Why this phase exists

Phase 1 gave you the vocabulary — idempotency, dual-write, state machines, the unknown-signal
problem. Phase 2 applies every one of those ideas to the domain where getting them wrong costs
someone real money: a payment gateway integration. By the end you should be able to explain, line
by line, why `payment-service.ts` is shaped the way it is — and why almost every shortcut you'd be
tempted to take produces a specific, nameable failure mode.

---

## 1. Money as integer minor units

`packages/santimpay/src/money.ts` opens with the reason this file exists at all:

> `0.1 + 0.2 === 0.30000000000000004`. Floating point cannot represent decimal fractions exactly,
> so any system that stores money as a float will, given enough transactions, produce totals that
> do not reconcile with the bank.

The fix: store money as an integer count of the smallest indivisible unit (**santim**, 1/100 ETB),
and only ever produce a float at the last possible moment, for a display string or a third-party
API that insists on one. `Santim` is a **branded type** —

```ts
export type Santim = number & { readonly __brand: unique symbol };
```

— which is not just documentation. It means `orderTotal: Santim = 500` (a plain number) fails to
typecheck; you're forced through `santim(500)` or `birr(5)`, which validate. A branded type turns
"remember not to mix up santim and birr" from a convention someone eventually forgets into
something the compiler refuses to compile.

### 1.1 Who eats the half-santim

The master plan asks this question directly, and the honest answer is: **it depends, and the
codebase makes you say which.** `applyRate()` takes an explicit `rounding` parameter —
`"half-up" | "down" | "up"`, defaulting to half-up because that's the convention Ethiopian
accounting expects — rather than picking one silently:

```ts
export function applyRate(
  amount: Santim,
  rate: number,
  rounding: "half-up" | "down" | "up" = "half-up",
): Santim {
  const raw = amount * rate;
  switch (rounding) {
    case "down": return santim(Math.floor(raw));
    case "up":   return santim(Math.ceil(raw));
    case "half-up": return santim(Math.round(raw));
  }
}
```

`money.test.ts`'s `applyRate() rounds explicitly` proves all three branches on the same input
(333 santim at 15%: half-up → 50, down → 49, up → 50) — the same money, three different legally
defensible answers, and the function makes you pick instead of hiding the choice inside
`Math.round`.

**The harder version of the same question:** splitting a discount, or a multi-item order's total,
across several line items, where naive division loses fractional santim. `allocate()` solves it
with the standard rule — divide, then distribute the remainder one santim at a time to the
earliest parts:

```ts
export function allocate(amount: Santim, parts: number): Santim[] {
  const base = Math.floor(amount / parts);
  const remainder = amount - base * parts;
  return Array.from({ length: parts }, (_, i) => santim(base + (i < remainder ? 1 : 0)));
}
```

`money.test.ts` proves the invariant that actually matters — not "is the split fair" (reasonable
people disagree) but **"does the sum of the parts equal the original amount, always"**:
`allocate(santim(100), 3)` → `[34, 33, 33]`, summing back to exactly 100. A version of this
function that just did `Math.floor(amount / parts)` for every part would silently lose a santim
on any amount not evenly divisible — small enough to never notice in a code review, large enough
that finance notices at the end of the month.

### 1.2 The IEEE-754 trap, specifically

`birr(19.99)` has to survive `19.99 * 100 === 1998.9999999999998` in floating point — a naive
`Math.trunc` would silently produce 1998 and lose a santim on every price ending the same way.
`birr()`'s guard:

```ts
const scaled = value * 100;
const rounded = Math.round(scaled);
if (Math.abs(scaled - rounded) > 1e-6) {
  throw new MoneyError(`birr supports at most 2 decimal places, received ${value}`);
}
return santim(rounded);
```

Round first, *then* compare the rounded value back against the raw scaled value within a small
epsilon — close enough is "this really was 19.99," not close enough is "this was actually
19.995 and you're silently discarding a sub-santim amount," which throws instead of guessing.
`money.test.ts`'s `birr() survives IEEE-754 representation error` and
`birr() rejects sub-santim precision instead of silently rounding` are the same function proven
from both directions: correct on the values that look wrong only because of floating point,
loud on the values that are actually too precise to represent.

**The rule to take away:** the moment you write `price * 100` or `total / 3` anywhere near money
without going through a function that has already had this argument with IEEE-754 on your behalf,
you have reintroduced the bug this whole file exists to prevent.

---

## 2. ES256/JWS signing, key handling, and the replay window

SantimPay authenticates every request — and signs every webhook callback — with a compact JWS
using ECDSA P-256 + SHA-256 (`ES256`), signed with the **same private key** the merchant hands
over at onboarding. `packages/santimpay/src/crypto.ts` is built around two non-negotiable rules
that exist because of exactly how easy each is to get wrong.

### 2.1 Sign the string, not the object

```ts
export function signES256(payload: Record<string, unknown>, privateKeyPem: string): string {
  return jwt.sign(JSON.stringify(payload), privateKeyPem, { algorithm: "ES256" });
}
```

The comment directly above this function in the real file is worth quoting verbatim, because the
failure mode it prevents is genuinely confusing the first time you hit it:

> Passing an object makes the library inject an `iat` claim; SantimPay reconstructs the expected
> body server-side, the extra claim breaks the match, and you get
> `{"message":"Invalid token","status":"declined"}`.

`jsonwebtoken`'s ergonomic default — "pass an object, we'll handle the JWT plumbing for you" —
is exactly wrong here, because SantimPay's server independently reconstructs the payload it
expects and compares signatures over the *exact* bytes. An extra field you didn't put there
yourself breaks verification with an error message that gives you no reason to suspect the
signing library added something. `crypto.test.ts`'s `signing does NOT inject an iat claim`
decodes the actual token and asserts its claim set is *exactly* `["amount", "generated"]` — proof
against regression, not just a comment trusting nobody changes this later.

### 2.2 A vendor inconsistency that will cost you an afternoon if undocumented

Every signing operation uses `merchantId` as the field name — except
`fetchTransactionStatus()`, which uses `merId`:

```ts
// packages/santimpay/src/client.ts, fetchTransactionStatus()
// NOTE: this signing body uses `merId`, while every other operation uses
// `merchantId`. Documented in the Additional integration document; getting
// it wrong yields "crypto/ecdsa: verification error".
const signedToken = signES256(
  { id: transactionId, merId: this.#merchantId, generated },
  this.#privateKey,
);
```

This is not a typo in this codebase — it's a real inconsistency in SantimPay's own API, and the
comment exists precisely because it is exactly the kind of detail that produces an hour of
confused debugging (a *correctly signed* token, rejected, because it was correctly signed
according to the wrong field name for *this specific* operation). **The lesson generalizes far
past this one field:** when a vendor's API is inconsistent with itself, the fix is never to
"clean it up" to what seems more consistent — it's to match their inconsistency exactly, in one
place, with a comment loud enough that the next person doesn't "fix" it back into a bug.

### 2.3 Algorithm pinning — why the token can never choose its own algorithm

```ts
decoded = jwt.verify(token, publicKeyPem, {
  algorithms: ["ES256"],   // pinned, not read from the token's own header
  ignoreExpiration: true,
});
```

`algorithms: ["ES256"]` is not a default — it's a deliberate allowlist, and it is defending
against a specific, well-documented class of real-world exploit: **algorithm confusion.** A JWT's
header carries its own `alg` field, and if a verifier naively trusts it, an attacker can:

- set `alg: "none"` and strip the signature entirely, or
- switch to `HS256` (a symmetric algorithm) and sign with the *public* key as the HMAC secret —
  which works, because the public key is, definitionally, public.

`crypto.test.ts` proves both attacks are actually rejected, not just theoretically blocked —
`algorithm confusion: alg=none is rejected` and
`algorithm confusion: HS256 signed with the public key is rejected` construct the literal forged
tokens an attacker would send and assert `verifyES256` throws on both. **The rule: never let the
token pick how it gets verified.** The verifier decides the algorithm, always, regardless of what
the token claims about itself.

### 2.4 The replay window

A captured signature stays "valid" (mathematically) forever unless something bounds its useful
lifetime. `verifyES256`'s `maxAgeSeconds` option enforces freshness against a `generated` (or
`iat`/`timestamp`) claim carried *inside* the signed payload — not against when the HTTP request
arrived, which an attacker replaying an old request controls:

```ts
const age = nowSeconds - generated;
if (age > maxAge) {
  throw new SantimPaySignatureError(`token is ${age}s old, maximum allowed is ${maxAge}s`);
}
if (age < -60) {
  throw new SantimPaySignatureError(`token is timestamped ${-age}s in the future`);
}
```

The webhook receiver defaults this to 5 minutes (`WEBHOOK_MAX_AGE_SECONDS`, `env.ts`). Note the
**two-sided** check — too old *and* too far in the future are both rejected, because a timestamp
from the future is exactly as suspicious as a stale replay; the only legitimate reason for a small
negative age is ordinary clock skew, which is why the future-tolerance (`-60`) is generous while
the past-tolerance is the caller's own configured window.

**And this is not the only defence against replay.** `webhook.ts`'s `verifyWebhook()` binds the
signed token to *this specific request body* after verifying the signature:

```ts
// Bind the signature to THIS body. Without this check an attacker who
// captured any valid signed token could attach it to a body of their
// choosing — a "1 birr" signature replayed onto a "50,000 birr" order.
assertClaimAgrees(claims, body, ["txnId", "thirdPartyId"]);
```

A valid, fresh, correctly-signed token is *still* rejected if its claims disagree with the body
it arrived attached to. Freshness alone isn't enough — a captured token replayed within its
validity window, but glued onto a different (larger) request body, is exactly the attack this
second check exists for.

---

## 3. Payment intent as an entity distinct from an order

An `Order` is what the customer bought. A `PaymentIntent` is *an attempt to collect money for it*
— and conflating the two is one of the most common structural mistakes in a payment integration,
because an order can legitimately have **more than one** payment attempt (a failed card, a
timed-out mobile-money prompt, a customer who abandons and comes back).

`prisma/schema.prisma` models them as separate entities with a one-to-many relationship (an
`Order` has `payments: PaymentIntent[]`), and `startPayment()` in `payment-service.ts` reuses an
in-flight intent rather than creating a second one on a double-click:

```ts
const reusable = order.payments.find(
  (p) => (p.status === "CREATED" || p.status === "PENDING") && p.paymentUrl,
);
if (reusable?.paymentUrl) {
  return { paymentUrl: reusable.paymentUrl, merchantTxnId: reusable.merchantTxnId };
}
```

**Why this matters concretely:** if `Order` itself carried the payment fields (a `paymentUrl`
column directly on the order, say), a second payment attempt would have nowhere to go except
overwriting the first — and if the first attempt's webhook arrives *after* the second attempt
started, you've just lost the ability to tell which attempt it's even about. Separate entities
means separate identities means every callback, every poll, every reconciliation sweep operates
on an unambiguous `merchantTxnId`, no matter how many attempts an order accumulates.

### 3.1 The ordering that makes this safe under a mid-flight crash

`startPayment()`'s module comment states the rule directly, and it is the single most
consequential sentence in this section:

> ORDERING IS THE WHOLE POINT. The intent row is committed BEFORE the gateway is called. If the
> process dies immediately after the gateway accepts the request, the reconciler finds the intent
> by `merchantTxnId` and recovers the payment. Had we called first and saved after, that customer
> would be charged for an order we have no record of — the single worst outcome in commerce.

```ts
const merchantTxnId = ulid();
const intent = await prisma.paymentIntent.create({
  data: { orderId: order.id, merchantTxnId, amountSantim: order.totalSantim, status: "CREATED" },
});
// only now, call SantimPay
const { paymentUrl } = await santimpay().createCheckoutSession({ transactionId: merchantTxnId, ... });
```

This is Phase 1 §3.2's client-generated idempotency key pattern, applied to the specific case
where the "client" generating the key is your own server, about to call a third party. The
`merchantTxnId` — a ULID, chosen deliberately over a UUIDv4 because it's lexicographically
sortable by creation time, letting support eyeball ordering and keeping the database index
sequential rather than randomly scattered — exists *before* SantimPay has ever heard of this
payment attempt.

### 3.2 What "duplicate reference" actually means, and why it isn't a failure

SantimPay's protocol documents that reusing a `transactionId` returns
`"Duplicate Client Reference."` — and this codebase gives that response its own exception type
specifically so it can never be handled the same way as a real failure:

```ts
// errors.ts
export class DuplicateReferenceError extends SantimPayError {
  readonly kind = "duplicate_reference" as const;
  readonly retryable = false;
  constructor(readonly transactionId: string, context: SantimPayErrorContext = {}) {
    super(
      `Transaction id "${transactionId}" was already used. Resolve via fetchTransactionStatus() ` +
      `rather than re-initiating.`,
      context,
    );
  }
}
```

`startPayment()`'s catch block acts on exactly this distinction: a `DuplicateReferenceError`
triggers a **settlement** (ask what actually happened), never a customer-facing failure message:

```ts
if (error instanceof DuplicateReferenceError) {
  logger.warn("payment.duplicate_reference", { orderId, merchantTxnId });
  await settlePayment(merchantTxnId, "duplicate-recovery");
  const refreshed = await prisma.paymentIntent.findUniqueOrThrow({ where: { merchantTxnId } });
  if (refreshed.paymentUrl) return { paymentUrl: refreshed.paymentUrl, merchantTxnId };
}
```

**Why this is a completely different code path from a network error:** a network error means "I
don't know if this happened." A duplicate-reference error means "this ID was already accepted,"
which is much stronger information — it means the *first* attempt is real and worth resolving,
not retrying from scratch. Treating it as a generic failure and showing the customer "payment
failed, try again" would risk a second, genuinely duplicate charge for an order that may already
be paid.

---

## 4. Why the redirect is not proof of payment

`docs/01-santimpay-protocol-spec.md` §5.2 states the rule and the reasons together:

> `successRedirectUrl` is hit **by the customer's browser**. A customer can: type the success URL
> directly, press back and re-trigger it, close the tab before the redirect fires (payment
> succeeded, redirect never happened), lose connectivity on mobile data mid-redirect.
>
> **Rule: the redirect updates the UI. It never updates money state.**

This is Phase 1 §1's "you cannot know, at the moment a request times out, whether the money
moved" fallacy, wearing a browser-shaped costume. A redirect is a client-controlled navigation
event — it proves nothing about server-side reality, and treating it as proof means a customer
who types the success URL from memory (or an attacker who guesses the pattern) gets shown "your
order is confirmed" for an order that was never actually paid.

**The real implementation, and the part worth noticing:** the confirming page's own comment states
the architectural consequence directly:

```tsx
// apps/web/src/components/order-confirmation.tsx
/**
 * WHY THIS EXISTS AT ALL: the browser's redirect back from SantimPay's hosted
 * page is not proof of payment — see docs/01-santimpay-protocol-spec.md §5.2.
 * This component NEVER trusts the redirect; it polls our own
 * `/api/orders/:orderNumber/status`, which reflects only what the webhook +
 * poller + reconciler have confirmed against the Transaction Status API. If
 * the customer closes this tab, the order still resolves correctly
 * server-side — this UI is a courtesy, not part of the correctness story.
 */
```

That last sentence is the one to sit with: **the UI is a courtesy, not part of the correctness
story.** If every browser tab watching this order closed the instant the redirect landed, the
order would still resolve correctly, because resolution happens entirely server-side, driven by
the webhook/poller/reconciler triple from Phase 1 §8 — asking SantimPay's Transaction Status API,
never trusting a client-supplied signal. The polling component (3-second interval, capped at ~100
polls / 5 minutes, matching the poller's own window order of magnitude) exists purely so a
*patient, connected* customer sees their confirmation update without a manual refresh. It changes
nothing about whether the order is actually paid.

---

## 5. Webhook handling, in full

`apps/web/src/app/api/webhooks/santimpay/route.ts`'s module comment states the contract this
endpoint must honour as four words, and each one maps to a specific, real consequence of getting
it wrong:

| Requirement | Why | What breaks without it |
|---|---|---|
| **FAST** — answer in < 2s | A slow endpoint looks like a dropped delivery to the gateway | Gateway-side retries, and a redelivery storm during an incident turns a small problem into a large one |
| **HONEST** — 200 means "durably recorded," not "processed" | The gateway trusts your 200 completely | Returning 200 for something you dropped means the gateway *stops retrying* — you have just told it "I have this," and you don't |
| **PARANOID** — reject unsigned/stale callbacks with 401 | An attacker can POST anything to a public URL | Skipping verification "temporarily to debug" is how a payment system gets a forged completion |
| **RAW** — read the body as text, never re-parsed JSON | The signature is computed over exact bytes | `JSON.parse` then re-serializing can reorder keys and reformat numbers — "signature valid in Postman, invalid in production" is *always* this bug |

The handler itself is short specifically because everything hard is delegated to `recordWebhook()`
and deferred to the worker — the route's entire job is verify, persist, acknowledge:

```ts
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();               // RAW
  try {
    const result = await recordWebhook(rawBody, headers);
    return Response.json({ received: true }, { status: 200 });   // FAST, HONEST
  } catch (error) {
    if (error instanceof SantimPaySignatureError) {
      return Response.json({ error: "unauthorized" }, { status: 401 });  // PARANOID
    }
    return Response.json({ error: "internal" }, { status: 500 }); // let the gateway retry
  }
}
```

**Notice the 500 path specifically.** A genuine server-side failure (database unreachable, say)
returns 500, *not* 200 — because 200 would tell SantimPay "got it, don't resend," permanently
losing a real payment notification. The only two acceptable responses to a webhook are "durably
recorded" (200) and "please retry, something's actually wrong on my end" (5xx). There is no
correct scenario where this endpoint returns 200 for something it failed to save.

### 5.1 What `recordWebhook()` deliberately does NOT do

The comment on `recordWebhook()` is explicit that it does the *minimum* durable work and nothing
more:

> Deliberately does NOT settle. ... this function does the minimum durable work (verify + persist)
> and hands settlement to the worker.

Settlement — actually deciding the order's fate — means calling SantimPay's Transaction Status
API, which is a second network round-trip with its own latency and failure modes. Doing that
*inside* the webhook handler would violate the FAST requirement above; a slow third-party status
check now sits directly in the critical path of "acknowledge this webhook within 2 seconds."
Instead, `recordWebhook()` verifies the signature, persists the event (relying on the
`(provider, gatewayTxnId, status)` unique constraint from Phase 1 §2 to make duplicate delivery a
no-op), and returns — leaving `settlePayment()` to run asynchronously, on the worker, where a slow
status check costs nothing to the gateway's redelivery patience.

---

## 6. Reconciliation — and where this codebase's own documentation is wrong

`docs/01-santimpay-protocol-spec.md` §5.4 describes the three-layer defence from Phase 1 §8 with
specific numbers:

> **Poller** — backoff 5s→10s→30s→1m→5m for up to 30 min. **Reconciler** — nightly cron over all
> non-terminal intents older than 1h.

Read the actual code and neither number is quite right anymore. `state-machine.ts`'s real
schedule:

```ts
const POLL_SCHEDULE_SECONDS = [5, 10, 20, 30, 60, 120, 300, 300, 600, 600, 900] as const;
```

Eleven steps, summing to 2,945 seconds — **just over 49 minutes**, not 30. And the reconciler
isn't a nightly cron at all — `worker/index.ts` runs it on a fixed in-process interval:

```ts
const RECONCILE_EVERY_MS = 15 * 60_000;   // every 15 minutes, not nightly
// ...
const cutoff = new Date(Date.now() - 60 * 60_000);   // sweeps intents older than 1h — this part matches the doc
```

**This is not a trick question or a typo left in on purpose — it's what actually happens when a
system evolves and its prose documentation doesn't keep pace, which is close to the default
outcome unless someone deliberately fights it.** Two honest lessons follow from finding this,
and both matter more than the specific numbers:

1. **Code is the ground truth; documentation is a claim about the code, not a substitute for
   reading it.** When the two disagree, the thing actually running in production is right by
   definition, and the doc has a bug, exactly the same category of bug as a wrong `if` condition
   — it just fails silently instead of loudly.
2. **This drift is itself evidence for why the reconciler exists at all.** The poll window grew
   from a presumably-once-accurate "30 min" to "49 min" as the schedule was tuned — but the
   reconciler's job (catch *everything* still unresolved past its own separate one-hour cutoff,
   regardless of what the poller's exact window is) doesn't depend on that number being right.
   The backstop is deliberately decoupled from the thing it's backstopping, which is exactly why
   a doc drifting out of sync with the poll schedule specifically doesn't quietly create a gap.

The admin reconciliation page (`apps/web/src/app/admin/(dashboard)/reconciliation/page.tsx`)
states the real numbers correctly, in its own on-page copy: *"sweeps everything older than an
hour every 15 minutes"* — matching the code, not the protocol doc. **When you find a
disagreement like this in a real codebase, the fix belongs in three places, not one:** correct the
stale doc, and while you're there, ask whether the two numbers disagreeing is itself a bug (here,
it isn't — the 49-minute figure was a deliberate tuning change the doc simply never caught up
with, confirmed by asking, not assumed).

### 6.1 The finance report — real, and honestly partial

The protocol spec says the reconciler's nightly sweep "feeds the finance report." No dedicated,
multi-period finance report page exists yet in this codebase — but a real, correctly-computed
revenue aggregate does, in `admin-queries.ts`'s `getDashboardStats()`:

```ts
const paidOrders = await prisma.order.findMany({
  where: { status: "PAID", paidAt: { gte: startOfDay } },
  select: { totalSantim: true },
});
// ...
revenueTodaySantim: paidOrders.reduce((sum, o) => sum + o.totalSantim, 0),
```

**The detail worth noticing is what this query does *not* do:** it does not sum every webhook
event received today, and it does not sum every payment intent created today. It filters on
`Order.status === "PAID"` — the state machine's own settled truth, reached only through
`applyPaymentTransition()`'s single decision path from Phase 1 §8. A revenue report built by
summing raw webhook payloads would double-count every retried delivery and include amounts from
payments that later failed or reversed. **A finance report is only as correct as the state
machine underneath it** — which is exactly why this phase spent so long on that state machine
before ever mentioning a report that reads from it.

---

## 7. Ledger thinking — introduced here, not yet built

Every state transition in `applyPaymentTransition()` writes an `OrderEvent` carrying the amounts
involved:

```ts
await tx.orderEvent.create({
  data: {
    orderId: input.orderId,
    type: `payment.${to.toLowerCase()}`,
    data: {
      gatewayTxnId: transaction.gatewayTransactionId,
      amountSantim: transaction.amountSantim,
      commissionSantim: transaction.commissionSantim,
    },
  },
});
```

This is a real, append-only audit trail — but it is **single-entry**: each row records that an
amount moved, not the two-sided claim of *where from and where to* that double-entry bookkeeping
requires. This codebase does not implement a ledger, and it's worth being precise about why that
gap is honest rather than a shortcoming to silently paper over: SantimPay itself holds the
merchant's real balance (`docs/runbooks/02-escrow-depleted.md`'s `santimpay_wallets` table is
*their* internal balance, not this codebase's) — a full double-entry ledger matters most once you
are also modelling *your own* internal cash positions (escrow held, commission owed, refunds
pending) as first-class accounts, which this project hasn't needed yet.

**The idea, for when you do need it:** every movement of money is recorded as at least two
balanced entries — a debit somewhere and an equal credit somewhere else — never a single number
that just changes. Applied here: "customer paid 500 santim" isn't one fact, it's two: *debit*
"cash received" 500, *credit* "customer's order balance" 500. The invariant a ledger gives you for
free, that a pile of status-updated columns never can: **the sum of every debit must always equal
the sum of every credit, across the entire system, at every point in time.** If it doesn't, you
have found a bug — not eventually, in a monthly reconciliation, but the moment you check. That
invariant is what Lab 2.4 below asks you to build and prove.

---

## Labs

Every lab below is one of the five "Break" exercises the master plan names for this phase. Build
the naive version first, watch it fail exactly the way described, then fix it — the value is in
feeling the failure before you fix it, not in reading the fix.

### Lab 2.1 — Same webhook, 100 concurrent deliveries, exactly one fulfilment

Using the real webhook fixture generator (`apps/web/scripts/generate-webhook-fixtures.ts` — see
its own header comment on why fixtures are pre-signed with the SDK's real signing code, not
hand-crafted JSON, tying back to Phase 1 §9 on why mocks lie), fire the *identical* signed payload
at `/api/webhooks/santimpay` 100 times concurrently (a `Promise.all` loop, or
`infra/load-testing/k6/webhook-burst.js` pointed at a single fixture repeated).

Prove: exactly one `WebhookEvent` row exists for that `(provider, gatewayTxnId, status)` triple,
the order transitions exactly once, and 99 of the 100 responses come back fast (the unique
constraint violation is caught and answered as a normal 200 "duplicate," not an error — re-read
`recordWebhook()`'s catch block for `isUniqueViolation`).

### Lab 2.2 — Tampered amount, rejected and alerted

Take a validly-signed webhook fixture and, *before* sending it, modify the `amount` field in the
JSON body without re-signing. Send it.

Prove it is rejected — but notice **where** in the pipeline it's rejected matters. A body-tamper
that changes a field the signed token's own claims assert (`txnId`, `thirdPartyId`) is caught by
`assertClaimAgrees()` inside signature verification itself, before your business logic ever runs.
An amount-tamper specifically is *not* one of the claim-bound fields — trace through
`settlePayment()` and find where `assertAmountMatches()` is the actual backstop, comparing the
gateway's *authoritative* status-check response (never the webhook body) against
`PaymentIntent.amountSantim`. Confirm an `OrderEvent` of type `payment.amount_mismatch` is written
and `paymentAmountMismatchTotal` increments — this should page someone, not fail silently.

### Lab 2.3 — Unsigned webhook, 401, learns nothing

`POST` to `/api/webhooks/santimpay` with a well-formed body and no `Signed-Token` header at all.
Confirm: 401, and the response body does **not** echo back *why* it was rejected (re-read the
route handler's comment on this specifically — an attacker probing your endpoint should learn
nothing from your error messages about how close they got). Then try a stale-but-correctly-signed
token (regenerate a fixture with a `generated` timestamp older than `WEBHOOK_MAX_AGE_SECONDS`) and
confirm the same 401, same silence.

### Lab 2.4 — Kill the process mid-flight; the reconciler heals it

The hardest and most valuable lab in this phase. Using the same technique as
`apps/web/scripts/chaos-checkout-atomicity.ts` (a deliberate lock to force a genuine stall, not a
race against a fast operation — see that script's own module comment for why a naive version of
this test is a lie), stall `startPayment()` **after** the gateway call succeeds but **before**
the `$transaction` that marks the intent `PENDING` commits. Kill the process there.

Prove: the `PaymentIntent` row exists (created *before* the gateway call, per §3.1 above) in
`CREATED` status, with a `paymentUrl` SantimPay already issued but this app never recorded. Then
run the reconciler's sweep by hand (or wait past its 1-hour cutoff in a test with a manipulated
`createdAt`) and confirm `settlePayment()` finds it, asks SantimPay what's true via
`fetchTransactionStatus()`, and resolves it correctly — completing an order whose initiating
process died mid-request, with the customer never seeing an error.

### Lab 2.5 — Testbed key against production; the app refuses to boot

Set `SANTIMPAY_ENVIRONMENT=testbed` and `DEPLOY_ENV=production` together and start the app.
Confirm it refuses to boot — re-read `env.ts`'s cross-field invariant:

```ts
if (env.DEPLOY_ENV === "production" && env.SANTIMPAY_ENVIRONMENT === "testbed") {
  throw new Error(
    "Refusing to boot: DEPLOY_ENV=production with SANTIMPAY_ENVIRONMENT=testbed. " +
      "Customers would be shown a payment page that never moves real money.",
  );
}
```

Then try the same experiment with the *other* two invariants in that function — a production
`SANTIMPAY_ENVIRONMENT` with no `SANTIMPAY_GATEWAY_TOKEN`, and a non-development `DEPLOY_ENV`
with a plain-HTTP `APP_URL`. All three should crash at boot, loudly, with a message that names
the exact misconfiguration — never three minutes into serving traffic, when the first customer's
payment attempt discovers it instead of you.

### Lab 2.6 — Build a minimal double-entry ledger

Not one of the master plan's five "Break" exercises, but the direct follow-through on §7 above.
Model two accounts (`cash_received`, `customer_orders`) as rows in a `ledger_entries` table with
`account`, `direction` (`debit`/`credit`), and `amountSantim` columns. Every time
`applyPaymentTransition()` would move an order to `PAID`, write *two* balanced ledger entries
instead of (or alongside) the existing single `OrderEvent`. Write a query that sums debits and
sums credits across the whole table and asserts they're equal — then deliberately break one write
path (write only the debit, "forget" the credit) and watch that invariant catch it immediately,
compared to how long the same bug would take to notice as a discrepancy in a monthly revenue
report.

---

## Gate — do not proceed to Phase 3 until you can do this cold

Given this codebase (or a payment gateway you've never seen before), answer without looking:

1. **Where, specifically, does money get represented as a float, and why is that location
   acceptable while every other location isn't?** (Answer: `toGatewayAmount()` — the one place a
   float is allowed to exist, and only in flight to a third party's JSON API that demands one.)
2. **Name the two checks that together defend against a captured, validly-signed webhook token
   being replayed onto a different request.** (Freshness against `generated`, and claim-agreement
   against the specific body it arrived with — either alone is insufficient.)
3. **Why does `startPayment()` persist the `PaymentIntent` before calling SantimPay, and what
   specifically goes wrong if you reverse the order?** (A crash between the two steps either
   leaves a recoverable orphaned intent, or — reversed — a charged customer with no record at
   all. Only one of those is survivable.)
4. **What does the confirming page actually trust, and what does it merely display?** (It trusts
   nothing from the browser's own redirect; it displays whatever the server-side polling endpoint
   — itself downstream of the webhook/poller/reconciler triple — reports as true.)
5. **You just found a real-world example of a project's documentation describing an old
   configuration that the code has since outgrown. What's the actual risk of that gap, and why
   was this specific gap survivable anyway?** (The risk is anyone trusting the doc's numbers to
   reason about the system's real behavior — support estimating "should be resolved by now"
   wrongly, say. It was survivable here because the reconciler's own cutoff is independent of the
   poller's exact schedule; the backstop doesn't rely on the number that drifted.)

If any of these took you more than a few seconds of genuine recall, re-read that section before
moving on — Phase 3 assumes this is reflex, not lookup.

---

*Next: `03-domain-modelling.md` — Phase 3: the e-commerce core underneath the payment layer —
concurrency-safe inventory reservation, the cart-to-order lifecycle, and why "check stock, then
write" is a race condition wearing a business-logic costume.*
