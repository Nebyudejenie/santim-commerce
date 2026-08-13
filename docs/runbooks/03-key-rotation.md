# Runbook: SantimPay key rotation

**Severity:** Planned maintenance (Low) when scheduled in advance. **Critical** if triggered by
suspected key compromise — in that case skip to [Emergency rotation](#emergency-rotation) below.

## Why this is unusually delicate

Read `docs/01-santimpay-protocol-spec.md` §1.1 before doing this for the first time. The short
version: our EC private key authenticates **both directions** — we sign outbound requests with
it, and SantimPay signs webhook callbacks with the *same* key, because we hand them a copy at
onboarding. Rotating it is therefore not a local config change; it requires a **coordinated
hand-off with SantimPay ops**, and there is an unavoidable window where old and new keys must
both work, or webhooks WILL fail signature verification the instant one side rotates before the
other.

## Planned rotation

### 1. Generate the new keypair

```bash
node -e "
const { generateKeyPairSync } = require('node:crypto');
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
console.log(privateKey);
console.log(publicKey);
"
```

(Or use `generateTestKeyPair()` from `@santim/santimpay` in a scratch script — same underlying
call, see `packages/santimpay/src/crypto.ts`.)

### 2. Coordinate the cutover window with SantimPay ops

Confirm in the integration group:
- Exact cutover time
- Whether SantimPay can accept the new **public** key ahead of time and hold both old+new active
  briefly, or whether it's a hard cutover (this determines whether step 4 has a safe overlap
  window or not — ask explicitly, this is one of the open questions in the protocol spec §8 that
  MUST be answered before a real rotation, not assumed)

### 3. Stage the new key in the secret manager — do not deploy yet

```bash
# Base64-encode for the _B64 env var path (see env.ts)
base64 -w0 new-private-key.pem
```

Update the secret in your External Secrets source (Vault / AWS Secrets Manager / GCP Secret
Manager — see `infra/k8s/README.md`'s secrets section) under a **new** key name alongside the
old one, e.g. `SANTIMPAY_PRIVATE_KEY_B64_NEXT`, so both are available simultaneously without
either being live yet.

### 4. Cut over

At the agreed time:
1. SantimPay ops activates the new public key on their side.
2. Update `SANTIMPAY_PRIVATE_KEY_B64` in the real secret to the new value.
3. Roll the deployment:
   ```bash
   kubectl rollout restart deployment/santim-web -n santim-commerce
   kubectl rollout restart deployment/santim-worker -n santim-commerce
   kubectl rollout status deployment/santim-web -n santim-commerce
   kubectl rollout status deployment/santim-worker -n santim-commerce
   ```
4. **Immediately** verify:
   ```bash
   curl -s https://shop.example.et/api/ready | jq   # config must still parse (env.ts validates PEM shape)
   ```
5. Place a small real test transaction (testbed environment first, always) and confirm both
   directions work:
   - Outbound: `createCheckoutSession` succeeds → new key signs correctly.
   - Inbound: the webhook callback verifies → SantimPay's new signature validates against our
     `derivePublicKey()`-derived public key (see `webhook.ts`).

### 5. Confirm no in-flight webhooks were dropped

```sql
SELECT COUNT(*) FROM webhook_events
WHERE "receivedAt" > NOW() - INTERVAL '30 minutes'
  AND "signatureValid" = false;
```

Any rows here during the cutover window are exactly the failure mode this runbook exists to
avoid — a webhook signed with the old key arriving after we switched to verifying against the
new one. If SantimPay confirmed a hard cutover with no overlap, this is a known/accepted risk for
whatever narrow window the switch took; if they promised overlap and this shows non-zero rows,
that's a coordination failure worth a follow-up with their ops team.

### 6. Clean up

Remove the old key from the secret manager once you've confirmed at least 24h of clean webhook
traffic — keep it that long specifically in case of a delayed/retried webhook signed before the
cutover.

## Emergency rotation

Suspected compromise changes the ordering: **rotate first, coordinate the mess after**, because
a leaked key is a live liability (whoever has it can both spend from escrow via `payout()` and
forge webhook callbacks that pass signature verification).

1. Generate a new keypair immediately (step 1 above).
2. Contact SantimPay ops out-of-band (phone/urgent channel, not just the integration group) and
   request immediate revocation of the current public key.
3. Deploy the new private key as soon as SantimPay confirms the new public key is active — accept
   a period where webhooks may fail verification; that is preferable to leaving a compromised key
   live.
4. Audit everything the old key could have touched:
   ```sql
   SELECT * FROM payment_intents
   WHERE status = 'COMPLETED' AND "updatedAt" > '<suspected compromise time>'
   ORDER BY "updatedAt" DESC;
   -- and, separately, every payout in the same window — those moved money OUT.
   ```
5. File a full incident report. This runbook covers the technical rotation only; a suspected key
   compromise also needs legal/compliance involvement per your organization's incident process.
