# Runbook: Stuck payments

**Severity:** Low by default (the system self-heals — see below). Escalate to Medium if
`santim_payments_unresolved` exceeds ~50, or if a specific customer has been waiting more than
30 minutes and is asking where their order is.

## What "stuck" means here

A `PaymentIntent` in `CREATED`, `PENDING`, or `EXPIRED` that has not resolved to `COMPLETED`,
`FAILED`, or `DECLINED`. This is **expected to happen constantly** in small numbers — Telebirr
and bank-rail confirmations legitimately take seconds to low-single-digit minutes. This runbook
is for when the *system meant to resolve it automatically* — see
`apps/web/src/worker/index.ts` — has not.

## 1. Confirm it's real

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://shop.example.et/api/metrics \
  | grep -E "santim_payments_unresolved|santim_payment_settlements_total"
```

Or the admin UI, which shows the same population with order numbers and emails attached:

```
https://shop.example.et/admin/reconciliation
```

## 2. Is the worker even running?

```bash
kubectl get pods -n santim-commerce -l app.kubernetes.io/name=santim-worker
kubectl logs -n santim-commerce -l app.kubernetes.io/name=santim-worker --tail=100
```

Look for `worker.started` in the logs (confirms boot) and recurring `payment.transition_ignored`
or `payment.settled` events (confirms it's actually ticking — see `settleDuePayments()` in
`worker/index.ts`). If the pod is `CrashLoopBackOff`, check for `worker.fatal` — this is almost
always `env()` validation failing (see `server/config/env.ts`), which means a secret rotated or
expired without the worker's config being updated.

**If the worker is down:** this alone can explain a growing stuck-payment count. Fix the crash
first (`kubectl describe pod` for the exact reason), then come back to step 3 to confirm the
backlog drains on its own once it's back — it should, without further intervention.

## 3. Look at ONE stuck payment specifically

```sql
SELECT
  pi.id, pi."merchantTxnId", pi.status, pi."pollAttempts", pi."nextPollAt",
  pi."createdAt", pi."lastPolledAt", pi."failureMessage",
  o."orderNumber", o.email, o.status AS order_status
FROM payment_intents pi
JOIN orders o ON o.id = pi."orderId"
WHERE pi.status IN ('CREATED', 'PENDING', 'EXPIRED')
ORDER BY pi."createdAt" ASC
LIMIT 20;
```

- **`nextPollAt` is in the past and `lastPolledAt` hasn't advanced** → the worker isn't picking
  it up. Back to step 2.
- **`lastPolledAt` is recent and status hasn't changed** → the worker IS polling, and SantimPay
  keeps reporting the same non-terminal state. This is very likely a genuinely slow payment on
  SantimPay's side (channel outage, bank maintenance window) — check
  [SantimPay's status page / integration group] before assuming it's on our side.
- **`pollAttempts` is at or near the schedule's max (see `nextPollDelaySeconds` in
  `orders/state-machine.ts` — 11 steps, ~50 minutes total)** → it will flip to `EXPIRED` soon and
  fall into the nightly reconciler's sweep instead of the fast poller.

## 4. Force a fresh check right now

Rather than waiting for the next scheduled poll, ask SantimPay directly via the admin UI's
**"Re-check with gateway"** button on the order or reconciliation page — this calls the exact
same `settlePayment()` function the poller uses (see `admin-actions.ts`'s module comment), just
triggered immediately instead of on a timer. Safe to click repeatedly; it is idempotent.

Or via the API directly, using the same merchant transaction id from step 3:

```bash
# There is no dedicated CLI for this today — the admin UI IS the interface.
# If you need this scripted (e.g. for a batch of 50 stuck payments), write a
# one-off script that imports settlePayment() from
# apps/web/src/server/payments/payment-service.ts directly, run with:
#   pnpm exec tsx your-script.ts
#
# NOT `node --experimental-strip-types` — every relative import under
# server/* uses an explicit .js extension pointing at a .ts file (required
# for the worker's own execution; see worker/index.ts's package.json script),
# and Node's native type-stripping does not resolve that, it only strips
# types from a single file. `tsx` does resolve it — same as the worker.
```

## 5. If the gateway itself says something unexpected

Check `PaymentIntent.failureMessage` and cross-reference against the error catalogue in
`docs/01-santimpay-protocol-spec.md` §6. A `crypto/ecdsa: verification error` here specifically
means a **key/environment mismatch** — go to the [key rotation runbook](./03-key-rotation.md)
immediately; this is not a "wait it out" situation, every subsequent status check will fail
identically until the key issue is fixed.

## Root cause checklist

- [ ] Worker pod restarts around the time the backlog started growing? (`kubectl get events -n
      santim-commerce`)
- [ ] A recent deploy changed `SANTIMPAY_*` env vars? (`kubectl rollout history deployment/santim-worker -n santim-commerce`)
- [ ] SantimPay incident on their end? (check the integration group / their status page)
- [ ] Database connection pool exhausted, causing `settlePayment()`'s `$transaction` calls to
      queue? (`SELECT count(*) FROM pg_stat_activity;` — compare against your pool size)

## Prevention

The reconciler (`reconcile()` in `worker/index.ts`) already sweeps everything older than an hour
every 15 minutes as the safety net under the safety net. If you're reading this runbook because
that safety net also failed, the actual bug is in the worker process itself — file it, don't
just clear the backlog and move on.
