# Runbook: Webhook outage

**Severity:** Medium initially — the poller and reconciler exist precisely so a webhook outage
does not mean lost payments (see `docs/01-santimpay-protocol-spec.md` §5.4). Escalate to High if
`santim_payments_unresolved` is climbing faster than the poller can drain it, which means the
fast path AND the slow path are both degraded.

## Symptom

One or more of:
- `santim_webhook_requests_total{result="unauthorized"}` spiking
- Webhook request volume drops to ~zero despite `santim_orders_placed_total` continuing normally
- Customers report paying successfully (bank SMS confirms it) but their order stays on the
  "confirming your payment" screen far longer than usual

## 1. Is it us, or is it SantimPay not calling us at all?

```sql
SELECT COUNT(*), MAX("receivedAt") FROM webhook_events
WHERE "receivedAt" > NOW() - INTERVAL '15 minutes';
```

- **Zero rows, `MAX` is stale** → SantimPay isn't reaching us at all. Go to step 2.
- **Rows exist but `signatureValid = false`** → we ARE receiving callbacks but rejecting them.
  Go to step 3.
- **Rows exist, valid, but `paymentIntentId IS NULL`** → callbacks for transaction ids we don't
  recognize (`webhook.unknown_intent` in the logs) — usually stale/duplicate test traffic, not an
  outage; confirm before treating as urgent.

## 2. SantimPay isn't reaching notifyUrl at all

Checklist, roughly in likelihood order:

- [ ] **DNS/TLS**: `curl -sv https://shop.example.et/api/webhooks/santimpay` from OUTSIDE the
      cluster (a laptop, not a pod) — confirms the public path SantimPay actually uses.
- [ ] **Ingress**: `kubectl get ingress -n santim-commerce santim-web` — still pointing at the
      right service? Recent change to `infra/k8s/base/ingress.yaml` or its overlay?
- [ ] **A WAF/bot-protection rule blocking it** — see the ingress.yaml module comment
      specifically warning against this. Check any recently added WAF rules first; this is the
      most common self-inflicted cause of "SantimPay stopped calling us."
- [ ] **IP allowlisting** — if inbound IP restrictions exist anywhere in the path (ingress
      annotation, cloud firewall, CDN), confirm SantimPay's source IPs are still allowed. (Get
      their current source IPs from the integration group — this is one of the open questions in
      the protocol spec §8 that should already be on file; if it isn't, get it now.)
- [ ] **notifyUrl itself wrong** — check what URL we're actually sending on `initiate-payment`:
      ```sql
      SELECT "paymentUrl" FROM payment_intents ORDER BY "createdAt" DESC LIMIT 1;
      ```
      then cross-check `urls().webhook` in `server/config/env.ts` resolves from the correct
      `APP_URL` for this environment (a stale `APP_URL` after a domain migration is a classic
      cause).

## 3. SantimPay IS calling us, but we're rejecting the signature

```sql
SELECT "gatewayTxnId", status, "receivedAt", error
FROM webhook_events
WHERE "signatureValid" = false
ORDER BY "receivedAt" DESC
LIMIT 20;
```

Cross-check application logs for `webhook.signature_rejected` around the same timestamps — the
`reason` field there (never echoed back in the HTTP response, by design — see `route.ts`'s
comment) tells you exactly which check in `verifyWebhook()` failed:

- **"missing signed-token header"** → SantimPay changed how they send the signature, or
  something in front of us (proxy/CDN) is stripping the header. Check `curl -sv` output for the
  header surviving end-to-end.
- **Signature verification failure from `jsonwebtoken`** → the deployed
  `SANTIMPAY_PRIVATE_KEY` doesn't match what SantimPay is signing with. This means a key mismatch
  — go to the [key rotation runbook](./03-key-rotation.md) and confirm nothing rotated
  unexpectedly (a bad secret-manager sync is a common cause here).
- **"token is Ns old, maximum allowed is 300s"** → clock skew between us and SantimPay, or a
  genuinely stale/replayed request. Check the pod's system clock
  (`kubectl exec -n santim-commerce deploy/santim-web -- date -u`) — should be NTP-synced and
  never drift meaningfully in a managed cluster; if it has, that's its own incident.
- **"disagrees with body on ..."** → either a real forgery attempt (check source IP in ingress
  access logs) or, more likely in practice, a proxy/CDN that re-serialized the request body
  somewhere in the path — re-read `webhook.ts`'s module comment on why RAW body handling matters
  end-to-end, including anything sitting in front of the app.

## 4. Mitigate while root-causing

The system is designed to tolerate this — confirm the safety net is actually engaged rather than
manually intervening:

```bash
kubectl logs -n santim-commerce -l app.kubernetes.io/name=santim-worker --tail=50 | grep -E "payment.settled|reconciler.sweep"
```

If the poller/reconciler are actively settling payments despite the webhook outage,
**no manual action is needed on individual orders** — customers will see their confirmation page
resolve within the poll window (up to ~50 minutes worst case; see `nextPollDelaySeconds` in
`state-machine.ts`) rather than instantly. Communicate that expectation to support if the outage
is expected to last a while, rather than having them manually chase every order.

## 5. After it's fixed

```sql
-- Anything the poller/reconciler haven't caught up on yet:
SELECT COUNT(*) FROM payment_intents WHERE status IN ('CREATED','PENDING','EXPIRED');
```

Watch this drain back to baseline. If it doesn't within the poll window, go to the
[stuck payments runbook](./01-stuck-payment.md).

## Prevention

- [ ] Is there an alert on `santim_webhook_requests_total` rate dropping to near-zero while
      order volume stays normal? (A pure "errors" alert misses a total-silence outage — the
      absence of traffic is itself the signal here.)
- [ ] Is there a synthetic check that periodically POSTs a deliberately-invalid signed request to
      confirm the endpoint is reachable and returns 401 (not 5xx, not a timeout)?
- [ ] Was the WAF/CDN change that caused this (if that was the cause) reviewed by anyone who
      knew this endpoint existed? If not, that's a process gap, not just a config fix.
