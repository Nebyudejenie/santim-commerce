# Runbooks

Each runbook follows the same shape on purpose: **Symptoms → Severity → Diagnose → Mitigate →
Root cause → Prevent**. When you're paged at 3am, you want steps you can execute half-awake, not
prose to interpret. Every SQL query and admin URL below is real — copy-pasteable against this
codebase's actual schema, not illustrative pseudocode.

| Runbook | Paged by |
|---|---|
| [Stuck payments](./01-stuck-payment.md) | `santim_payments_unresolved` gauge high, or the admin reconciliation queue growing |
| [Escrow depleted](./02-escrow-depleted.md) | A B2C payout declined with `INSUFFICIENT_MERCHANT_BALANCE` |
| [Key rotation](./03-key-rotation.md) | Scheduled maintenance, or suspected key compromise |
| [Webhook outage](./04-webhook-outage.md) | `santim_webhook_requests_total{result="unauthorized"}` spikes, or zero webhook traffic despite orders being placed |
| [Backup / restore drill](./05-backup-restore-drill.md) | Nothing — scheduled exercise, not an incident. Run monthly regardless |
| [Chaos engineering drills](./06-chaos-drills.md) | Nothing — scheduled exercises. Checkout atomicity is a repeatable script (`pnpm run chaos:checkout-atomicity`) |

## Before you page anyone

Check these three things first — they answer "is this actually broken?" in under a minute:

```bash
# Is the app itself healthy?
curl -s https://shop.example.et/api/ready | jq

# How many payments are actually stuck right now?
curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://shop.example.et/api/metrics \
  | grep santim_payments_unresolved

# The human-readable version of the same thing:
open https://shop.example.et/admin/reconciliation
```

If `/api/ready` returns `503`, that's a different incident — the app itself is degraded, not
just payments. Start with the readiness `checks` field to see which dependency failed.
