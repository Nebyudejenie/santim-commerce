# Phase 9 — Observability & SRE

*Same method as Phases 1–8: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. `apps/web/src/app/api/metrics/route.ts` names
this exact phase by number in its own comment — the same signal Phase 8 found in `pdb.yaml`, that
this codebase's manifests and code were written with this curriculum already in mind.*

---

## Why this phase exists

Every phase before this one produced *signal* — metrics counters, structured logs, the health/ready
probe split (Phase 8 §8), the runbooks. This phase is about what turns raw signal into something a
human trusts at 3am: a dashboard organized around real questions, alerts that page for the right
reasons and stay silent otherwise, and a documented, honest sense of what "healthy" actually means
for this specific system — none of which happens automatically just because metrics exist.

---

## 1. The three pillars, and the one this codebase already admits it's missing

`metrics.ts`'s own opening line names this exact phase directly — *"the RED/USE-method numbers the
curriculum's Phase 9 (Observability & SRE) builds dashboards and alerts on top of"* — a third
instance of the pattern Phase 8 already noticed twice (`pdb.yaml`'s "BREAK" reference,
`api/metrics/route.ts`'s own Phase 9 pointer, quoted again below): this codebase's own comments
were written expecting this curriculum to exist. The same module comment states the honest
pillar hierarchy directly, in its own words, not this curriculum's:

> Traces matter most for an integration like this one (see the curriculum), but metrics are what
> pages someone at 3am — a trace tells you why checkout is slow, a metric's burn-rate alert is what
> tells you to go look.

**Metrics** are real and genuinely well-built (§2 below). **Logs** are real and structured
(`logger.ts`, §1.1) but not aggregated anywhere — there's no Loki, no shipping pipeline, nothing
beyond `process.stdout`/`stderr`; in a real deployment, whatever collects container stdout
(a cluster-level log agent, not anything this codebase configures) would be the only thing making
these logs searchable at all. **Traces are entirely absent** — no OpenTelemetry SDK, no Tempo, no
Jaeger, no `traceId` propagated anywhere in this codebase, confirmed by grepping the whole
repository for any of those names and finding nothing. And the codebase's own comment, quoted
above, doesn't pretend otherwise — it states plainly that traces matter *most* for exactly this
kind of system (a payment integration, where "why was this specific checkout slow" is a
request-scoped question metrics can't answer and logs can only answer by luck) while being
completely honest that metrics are what's actually built.

**Why that priority ordering is defensible even though traces matter more, in principle:** a
metric's job is *telling you something is wrong, fast, cheaply, in aggregate* — it's what a
burn-rate alert (§5) is built on, and it's the thing that actually pages a human. A trace's job is
*explaining one specific slow or failed request once you already know to look* — invaluable
during investigation, useless as a paging signal on its own (nobody pages on "this one trace was
slow"). Building the pillar that tells you *to look* before the pillar that tells you *why*, once
you're already looking, is a reasonable sequencing choice under real constraints — not proof that
tracing doesn't matter.

### 1.1 Logs — structured, and redacted at the one place that can't be forgotten

`logger.ts`'s own two rules:

> 1. LOG JSON, NOT PROSE. `logger.info("payment completed", { orderId })` is queryable in
>    Loki/CloudWatch. `console.log("payment completed for " + id)` is not, and at 3am you will be
>    writing regexes instead of fixing things.
> 2. REDACT AT THE LOGGER, NOT AT THE CALL SITE. Anyone can forget on one line. A private key or a
>    full MSISDN in a log aggregator is a breach that survives in backups long after you delete the
>    line.

The redaction is real, not aspirational — every field value passes through `redact()` before a log
line is ever written:

```ts
const REDACT_KEYS = [
  "privatekey", "private_key", "signedtoken", "signed_token", "authorization",
  "password", "passwordhash", "sessionsecret", "gatewaytoken", "secret", "token",
];

const MSISDN = /(\+251)(\d{1})(\d{4})(\d{4})/g;
```

Two different redaction strategies for two different shapes of sensitive data: known *field names*
(`SANTIMPAY_PRIVATE_KEY`, `SESSION_SECRET` — anything matching `REDACT_KEYS`, case-insensitive) get
replaced wholesale with `[redacted]`, recursively through nested objects and arrays up to a depth
limit; a phone number, which isn't a distinctly-named field so much as a *shape* that can appear
anywhere in a log's data payload, gets partially masked in place
(`+251912345678` → `+2519****5678`) rather than fully redacted — preserving enough to be useful for
support correlation ("does this match the number on the ticket") without logging the complete
MSISDN. **The rule this teaches, generalized:** centralizing redaction at the *one* function every
log line passes through means a new call site anywhere in the codebase gets this protection for
free, automatically, without whoever wrote that call site needing to remember it exists — the same
"one place decides" shape as Phase 2's `applyPaymentTransition()` and Phase 3's `calculateTax()`.

---

## 2. Instrumenting the payment path — one registry, defined once

`metrics.ts`'s own comment states the discipline directly:

> ONE REGISTRY, DEFINED ONCE. Every metric name and label set lives in this file. The alternative —
> `new Counter(...)` scattered at each call site — is how projects end up with three different
> metrics all meaning roughly "a payment happened," none of which agree, and a Grafana dashboard
> nobody trusts. Call sites only call the small `record*` functions below.

Real counters, gauges, and one histogram, each named for a specific question a dashboard or alert
needs answered — not a generic "requests" counter with labels bolted on until it can answer
everything, which tends to answer nothing precisely:

```ts
export const paymentAmountMismatchTotal = new client.Counter({
  name: "santim_payment_amount_mismatch_total",
  help: "Callbacks where the gateway-reported amount disagreed with our records. Should always be zero — alert on >0.",
  registers: [registry],
});
```

That `help` string is doing real work beyond documentation — it states the metric's *expected*
value (zero) directly in the metric's own metadata, which is exactly the information someone
writing an alert rule six months from now needs and might otherwise have to reverse-engineer from
`payment-service.ts`'s own code (Phase 2 §5's `assertAmountMatches`, the check this counter
observes).

### 2.1 Distinguishing "the gateway is slow" from "we are slow" — a distinction that changes who
gets paged

```ts
/**
 * Duration of outbound calls to SantimPay itself, not our own request
 * handling — this is what tells you "the gateway is slow today" versus
 * "our checkout handler is slow today," a distinction that changes who gets
 * paged.
 */
export const santimpayRequestDuration = new client.Histogram({
  name: "santim_gateway_request_duration_seconds",
  help: "Latency of calls to the SantimPay API.",
  labelNames: ["operation", "outcome"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});

export async function timeGatewayCall<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const stop = santimpayRequestDuration.startTimer({ operation });
  try {
    const result = await fn();
    stop({ outcome: "success" });
    return result;
  } catch (error) {
    stop({ outcome: "error" });
    throw error;
  }
}
```

`payment-service.ts` wraps every real SantimPay call (`createCheckoutSession`,
`fetchTransactionStatus` — Phase 2 §§3–5) through this one function. Without a metric measuring
*specifically* the third-party call's own latency, a slow checkout page looks identical whether the
slowness is SantimPay's servers or this application's own code — and those two causes need
completely different people paged, completely different mitigations, and completely different
conversations with the vendor. One histogram, wrapping one function, is what makes that
distinction observable at all instead of requiring a trace (§1's absent third pillar) to work out
after the fact.

---

## 3. Dashboards — real, organized by the questions someone actually asks

`infra/observability/grafana/dashboards/santim-commerce.json` is a real, provisioned dashboard
(not a placeholder — Grafana's own provisioning config in
`infra/observability/grafana/provisioning/` loads it automatically), organized into four sections
that map directly onto `metrics.ts`'s own comment about RED/USE-method numbers:

- **Checkout** — orders placed, checkout failures by reason, checkout sessions by outcome (Rate
  and Errors, in RED terms)
- **Payments** — amount mismatches, unresolved payments right now, settlements by status, gateway
  latency at p50/p95/p99, gateway call outcome (Duration, plus the gateway-vs-app distinction from
  §2.1)
- **Webhooks & inventory** — webhook requests by result, reservations expired
- **Process health** — CPU usage, resident memory (Utilization, in USE terms — the process-level
  complement to the request-level RED panels above it)

**The organizing principle worth naming:** every panel maps to a real question this curriculum has
already spent eight phases establishing the stakes of — "amount mismatches" is Phase 2 §5's
never-supposed-to-happen check, given its own panel specifically because a nonzero value there is
a security incident, not routine noise; "unresolved payments right now" is the same number
`stuckPaymentsGauge` feeds and the admin reconciliation page (Phase 2 §6) shows a human-readable
version of. A dashboard built from questions the team already knows matter, rather than from
whatever metrics happened to exist, is what makes it something "a stranger can read at 3am" — the
master plan's own bar for this — instead of a wall of graphs requiring institutional memory to
interpret.

---

## 4. SLIs, SLOs, and error budgets — the gap this phase's own lab exists to close

None of these are formally defined anywhere in this codebase. That's a real, current gap — not
hedged the way Phase 6 §3's deploy-strategy reasoning was, because there's no comment anywhere
explaining *why* an SLO for checkout wasn't defined; it simply wasn't done yet. What *is* real and
directly usable: every raw ingredient an SLO needs already exists as a metric.

**The concepts, precisely, using this project's own real counters as the worked example:**

- **SLI (Service Level Indicator)** — a specific, measured ratio. For checkout specifically:
  successful payment settlements over total checkout attempts, in a given window. Built directly
  from real, existing metrics: `paymentSettlementsTotal{status="COMPLETED"}` divided by
  `ordersPlacedTotal` (or `checkoutSessionsTotal`, depending on exactly where "attempt" is defined
  to start — a real design decision an SLI requires you to make explicitly, not something with one
  obviously correct answer).
- **SLO (Service Level Objective)** — a target for that ratio over a rolling window, e.g. "99.5%
  of checkout attempts settle successfully within 30 days." The number itself is a business
  decision (how much failure is acceptable) informed by, but not derivable purely from, engineering
  — the same category of decision Phase 7 §5 declined to make unilaterally regarding cloud spend.
- **Error budget** — the inverse of the SLO, made concrete: at 99.5%, this project is *allowed*
  0.5% of checkout attempts to fail over 30 days before the SLO itself is breached. An error
  budget's real power is turning "should we ship this risky change" from a values debate into an
  arithmetic one: if the budget is nearly exhausted, the answer is no, ship the fix instead — a
  decision framework, not just a monitoring number.

**Why this belongs in a lab and not a number this document invents:** picking 99.5% (versus 99.9%,
versus 99%) requires knowing this project's actual real-world traffic, actual observed failure
modes, and actual business tolerance for a failed checkout — none of which exist as real data yet,
since this application has never served real production traffic. Writing a specific target here
would be exactly the kind of unfounded number this curriculum has avoided everywhere else (Phase 7
§5's cost figures, for the identical reason).

---

## 5. Alerting — absent, and what it would need to lean on

No Alertmanager configuration, no alert rules file, anywhere in this repository. What real
alerting *would* build on, directly, without needing new instrumentation:

- **`paymentAmountMismatchTotal`** — a textbook symptom-based alert: `increase(...[5m]) > 0`,
  should fire on the very first occurrence, exactly because the metric's own `help` string already
  states the expected value is zero.
- **A burn-rate alert for the checkout SLO** (§4) — the standard SRE pattern pages faster the
  faster the error budget is being consumed: a short window (5–10 minutes) catching a severe,
  fast-burning failure, and a longer window (1–6 hours) catching a slow, sustained one, both
  computed from the same underlying SLI ratio rather than two unrelated thresholds someone picked
  independently.
- **`santim_payments_unresolved`** (the gauge behind the admin reconciliation queue, Phase 2 §6) —
  a sustained high value, not a single spike, since some nonzero count is normal and expected
  (payments genuinely take time to resolve); the alert-worthy signal is the number *not coming
  back down* within the poller's own ~49-minute window (Phase 2 §6).

**Symptom-based, not cause-based, is the discipline worth stating explicitly:** alert on
"checkouts are failing" (a symptom a customer would notice), not on "CPU is at 80%" (a cause that
may or may not actually be hurting anyone) — the latter is exactly how alert fatigue starts, paging
someone for numbers that fluctuate normally and training them to ignore pages, which is the
precise moment a real incident's alert also gets ignored.

---

## 6. Incident response — real structure, informal roles

Every one of the six runbooks in `docs/runbooks/` follows an identical, deliberate shape —
`docs/runbooks/00-index.md`'s own framing states why directly: *"When you're paged at 3am, you want
steps you can execute half-awake, not prose to interpret."* Concretely, each runbook moves through
**Symptoms → Severity → Diagnose → Mitigate → Root cause → Prevent**, with real, copy-pasteable
SQL and admin URLs throughout rather than illustrative pseudocode — `docs/runbooks/01-stuck-payment.md`'s
own severity framing (*"Low by default (the system self-heals — see below). Escalate to Medium
if..."*) is a real example of a runbook making the "how bad is this, really" judgment call
explicit rather than leaving it to whoever's paged to guess under pressure.

**What's real and what isn't, precisely:** the runbook *content* — diagnosis steps, mitigation,
root cause, prevention — is genuinely thorough and specific to this codebase. What's absent is any
formal **incident commander / communications lead** role structure, a documented **timeline**
template for a live incident, or a **blameless postmortem** template — the parts of incident
response that are about *coordinating humans* during and after an incident, as opposed to
diagnosing the system. A single-person team (or a project that's never had a real incident yet, per
the environment this curriculum was written in) doesn't feel this gap the way a growing on-call
rotation eventually will — worth building before that growth, not during the first incident it
actually matters for.

---

## 7. Runbooks as code, game days — closer to real than most of this phase

The phrase "runbooks as code" usually means executable, not just descriptive — a script that *is*
the runbook, not documentation of steps a human types by hand. This project has one genuine example
of exactly that, already covered in depth in earlier phases: `apps/web/scripts/chaos-checkout-atomicity.ts`
(Phase 2 Lab 2.4) is a real, permanent, self-cleaning script — `pnpm run chaos:checkout-atomicity`
— that doesn't just describe how to verify checkout-transaction atomicity, it *performs* the
verification, with a real, deliberate database-connection kill and a real assertion on the result.
`docs/runbooks/06-chaos-drills.md` documents this exact drill's real, measured 2026-08-13 results
(not projections) — the closest thing this project has actually done to a **game day**: injecting
a real failure, on purpose, on a schedule, specifically so the first time that failure happens for
real isn't also the first time anyone learns how the system behaves under it.

**What that runbook's own "Prevention / process" checklist is honest about, worth reading as this
phase's own closing note:** *"Are these drills actually scheduled, or did they happen once because
a codebase was being built and are now just... here? (Being honest: right now it's the latter.)"*
A single well-executed chaos drill and a genuinely scheduled, recurring practice are different
levels of maturity, and this project has honestly only reached the first one.

---

## Labs

### Lab 9.1 — The master plan's own required lab: define, instrument, break, and watch

Define a real SLO for checkout success rate using this project's own metrics (§4) — pick a
specific ratio definition and a specific target, and write down your reasoning for both, the same
way this document declined to invent one for you. Write the corresponding Prometheus recording
rule and a two-window burn-rate alert (§5). Then break it *deliberately*: point
`SANTIMPAY_MERCHANT_ID` at an invalid value, or otherwise force `startPayment()` to fail
consistently, and generate enough checkout attempts to actually burn through the error budget
within your alert's fast-burn window. Confirm the alert fires — and confirms it does *not* fire
during normal operation first, so you know the baseline wasn't already noisy enough to make this a
false positive.

### Lab 9.2 — Add the missing pillar

Instrument the checkout path — `placeOrder()` through `startPayment()` through the webhook/poller/
reconciler convergence (Phase 2's central architecture) — with real OpenTelemetry spans, exported
to a local Tempo (or Jaeger) instance. Propagate a trace ID from the initial checkout request
through to the eventual `settlePayment()` call, however many minutes later it actually resolves —
the interesting engineering problem here isn't instrumenting one request, it's carrying trace
context across the webhook/poller/reconciler triple's inherent asynchrony, where the "request" that
completes a trace may be a completely different HTTP call, triggered by a completely different
process, than the one that started it.

### Lab 9.3 — Write the postor-mortem structure §6 found missing

Using a real past chaos drill (Phase 2 Lab 2.4 or `docs/runbooks/06-chaos-drills.md`'s Drill 2) as
the subject, write a blameless postmortem as if it had been a real incident — timeline, impact,
root cause, what went well, what didn't, concrete action items with owners. This is deliberately
retrospective, on an event whose outcome is already known to be "the system handled it correctly,"
specifically so the *format* is what's being practiced, not the pressure of writing one during an
actual live incident for the first time.

---

## Gate — do not proceed to Phase 10 until you can do this cold

1. **This codebase's own metrics module says traces matter most for an integration like this one,
   then doesn't build them. Is that a contradiction? Resolve it.** (No — a metric is what pages you
   *to look*; a trace is what explains *why*, once you're already looking. Building the
   paging-capable pillar first is a defensible sequencing choice, not evidence tracing doesn't
   matter; it's an honest admission of what's actually complete versus what matters most in
   principle.)
2. **Why does `santim_gateway_request_duration_seconds` need to exist as a separate metric from
   whatever measures this app's own request latency?** (Because "the gateway is slow" and "our
   checkout handler is slow" require different people paged and different mitigations — collapsing
   them into one number makes that distinction unanswerable without a trace.)
3. **Define, in your own words, the relationship between an SLO and an error budget, using this
   project's checkout path as the example.** (The SLO is the target ratio of successful checkouts
   over a window; the error budget is what's left of the allowed failure rate before that target is
   breached — and a nearly-exhausted budget is a real decision input for "should we ship this risky
   change right now," not just a dashboard number.)
4. **Why should an alert on `santim_payments_unresolved` fire on a sustained elevated value rather
   than any nonzero reading?** (Some nonzero count is the expected, normal state — payments
   genuinely take time to resolve through the poller's own ~49-minute window; the alert-worthy
   signal is the count *not coming back down* within that expected window, not its mere existence.)
5. **Name the one real, executable "runbook as code" this project has, and what makes it different
   from the other five runbooks in `docs/runbooks/`.** (`chaos-checkout-atomicity.ts` — unlike the
   other five, which are markdown documentation a human follows by hand, this one is a script that
   *performs* its own verification and asserts a real pass/fail result, run for real with measured,
   dated output rather than described in prose.)

---

*Next: `10-security-and-compliance.md` — Phase 10: everything this codebase already does for
security (Phase 1's HS256-confusion defenses, Phase 5's non-root containers, Phase 6's keyless
signing and OIDC federation) named as one coherent posture, and what compliance actually requires
on top of good engineering practice, which are not the same thing.*
