# Runbook: Merchant escrow depleted

**Severity:** High. This blocks refunds and payouts — real customers waiting on real money back.
Page finance/ops, not just engineering; this is fundamentally a business action (top up the
account), not a code fix.

## Symptom

A B2C payout (`SantimPayClient.payout()` — refunds, withdrawals) fails with:

```
ERROR: new row for relation "santimpay_wallets" violates check constraint
"chk_santimpay_wallets_balance_is_non_negative" (SQLSTATE 23514)
```

Our SDK classifies this as `INSUFFICIENT_MERCHANT_BALANCE` (`classifyDecline()` in
`packages/santimpay/src/errors.ts`) — check for that code specifically rather than grepping logs
for the raw Postgres error text, which is SantimPay-internal and not a stable contract (see the
protocol spec §6's note on why we translate it at all).

## 1. Confirm scope

```sql
SELECT
  pi."merchantTxnId", pi."amountSantim", pi."failureCode", pi."failureMessage", pi."createdAt",
  o."orderNumber", o.email
FROM payment_intents pi
JOIN orders o ON o.id = pi."orderId"
WHERE pi."failureCode" = 'declined'
  AND pi."failureMessage" ILIKE '%non_negative%'
ORDER BY pi."createdAt" DESC
LIMIT 50;
```

This is every refund/payout attempt that failed for this reason — the blast radius, and the
list finance needs to know is waiting.

## 2. Immediate mitigation

**There is no code-level fix.** The merchant escrow/deposit balance is a real account balance
held with SantimPay; it is depleted because payouts have genuinely exceeded what's in it. The
only fix is topping up the account through whatever channel SantimPay provides for merchant
deposits (confirm the current process in the integration group — it is not documented in the
PDFs this project's spec was built from, which is itself worth flagging back to SantimPay ops;
see `docs/01-santimpay-protocol-spec.md` §8).

While waiting on the top-up:

- Do **not** retry the same payout blindly — it will fail identically until the balance changes,
  and each attempt is a real API call worth tracking (see `santim_gateway_request_duration_seconds`
  with `operation="payout-transfer"` in Grafana).
- Tell affected customers there's a delay, if support has visibility into which orders are
  affected — the query in step 1 is exactly that list.

## 3. After the top-up

Retry each affected payout. Since `payout()` uses the SAME transaction id as idempotency key
(see `client.ts`'s `PayoutInput.transactionId` doc), reusing the original id is safe and
correct — do not generate a new id per retry, or you risk a `DUPLICATE_CLIENT_REFERENCE` if the
first attempt actually landed despite the balance error surfacing (rare, but check via
`fetchTransactionStatus` before assuming a clean retry is needed).

## Root cause / prevention

This is fundamentally a **capacity planning problem**, not an incident to firefight repeatedly:

- [ ] Is there a dashboard/alert on the merchant balance itself, independent of payout failures?
      (Today, this codebase only finds out reactively, via a failed payout — see the open
      question in the protocol spec §8 about whether SantimPay exposes a balance-check API.)
- [ ] What's the actual burn rate of payouts (refunds + withdrawals) vs. top-up cadence?
      `santim_payment_settlements_total{status="COMPLETED"}` filtered to payout-type
      transactions gives the volume side of this.
- [ ] Does finance have a standing top-up schedule, or is it purely reactive today? If reactive,
      that's the real fix to propose after the second occurrence of this runbook.
