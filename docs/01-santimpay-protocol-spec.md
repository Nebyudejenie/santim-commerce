# SantimPay Gateway — Complete Protocol Specification

> Reconstructed from `Ecommerce integration document.pdf`, `Additional integration document.pdf`,
> and the vendor `santimpay-wallet-sdk` source. This is the **single source of truth** for our
> integration. Where the vendor SDK contradicts the PDF, the contradiction is called out explicitly.

---

## 0. Who SantimPay is, and what that means for our architecture

SantimPay Financial Solutions SC is a **Payment System Operator (PSO)** licensed under National Bank
of Ethiopia Proclamation No. 718/2011. It is not a card processor like Stripe. It is an *aggregator*
sitting in front of Ethiopian payment channels:

- **Mobile money wallets** — Telebirr, CBE Birr, M-Pesa (Safaricom ET), HelloCash, Amole
- **Bank rails** — CBE, Awash, Bunna, Amhara Bank, Abyssinia, Dashen …
- **SantimPay's own UPI wallet**

**Architectural consequence #1 — currency.** Everything is **ETB**. There is no multi-currency
support. Do not build a currency abstraction you will never use; do build a `Money` type that stores
**integer minor units** (santim) so you never hit float drift.

**Architectural consequence #2 — the channels are slow and flaky.** A Telebirr confirmation may take
seconds or minutes, and `PENDING` is a *real, long-lived* state ("if the transaction is under
approval of the channels"). Your order state machine must tolerate a payment that stays unresolved
for minutes. Synchronous request/response checkout is not an option.

**Architectural consequence #3 — no idempotency key header.** Unlike Stripe's `Idempotency-Key`,
SantimPay derives idempotency from *your* `id` / `clientReference`. Sending a duplicate returns
`"Duplicate Client Reference."`. You own idempotency. This is the single biggest source of
double-charges in Ethiopian integrations.

---

## 1. Environments

| Environment | Base URL |
|---|---|
| Testbed | `https://testnet.santimpay.com/api/v1/gateway` |
| Production | `https://services.santimpay.com/api/v1/gateway` |

Credentials issued per environment, **shared over the integration group** (Telegram, in practice):

| Credential | Type | Notes |
|---|---|---|
| `merchantId` | UUID string | e.g. `9e2dab64-e2bb-4837-9b85-d855dd878d2b` |
| Private key | **EC PRIVATE KEY** PEM (P-256 / prime256v1) | Used to sign every request payload |
| Gateway token | Opaque bearer token | PDF p.5: *"Gateway token shall be provided on the header as bearer token"* |

> ⚠️ **Vendor SDK discrepancy #1.** The PDF requires the gateway token as
> `Authorization: Bearer <token>`. In the vendor SDK the header block is **commented out** on every
> single call (`src/index.js`). Our client sends it when configured, and treats its absence as a
> deployment misconfiguration in production. Do not copy the vendor SDK here.

### 1.1 The key-exchange model (read this twice)

From the PDF's security requirements: *"The ecommerce site shall provide Private key before go
live."*

This is unusual and worth understanding precisely, because it dictates how you verify webhooks:

```
        merchant generates EC P-256 keypair
                     │
      ┌──────────────┴───────────────┐
      │                              │
  keeps private key            hands private key
  (signs outbound              to SantimPay during
   requests)                    onboarding
                                      │
                              SantimPay signs
                              webhook callbacks with it
                                      │
                              merchant verifies with the
                              PUBLIC key derived from its
                              own private key
```

So the *same* keypair authenticates both directions. It is a shared asymmetric key rather than a
true two-key design.

**Security posture this forces on us:**

1. The private key is a **bearer credential for both directions**. It never touches the repo, never
   touches a `.env` committed anywhere, never appears in logs. It lives in a secret manager
   (Kubernetes `Secret` sourced from Vault / AWS Secrets Manager / SOPS-encrypted file).
2. Because SantimPay also holds it, this key **cannot** be used for non-repudiation. A valid
   signature proves "someone holding the key", not "SantimPay specifically". Signature validity is
   therefore *necessary but not sufficient* — every webhook must still be confirmed against the
   Transaction Status API before we release goods. (Section 5.4.)
3. Key rotation requires a coordinated hand-off with SantimPay ops. Plan it; document it in the
   runbook.

---

## 2. Cryptography — the JWT signing scheme

Every request carries a `signedToken`: a **JWS in compact form, ES256** (ECDSA on P-256 with
SHA-256).

The vendor implementation:

```js
// src/utils/cryptography.js
export function sign(payload, privateKey, algorithm) {
    return jwt.sign(JSON.stringify(payload), privateKey, { algorithm })
}
export function signES256(payload, privateKey) {
    return sign(payload, privateKey, 'ES256')
}
```

Two subtleties that bite people:

- **`JSON.stringify(payload)` is deliberate.** Passing a *string* to `jsonwebtoken` makes it treat
  the payload as opaque and **skip auto-injecting `iat`**. If you pass the object directly,
  `jsonwebtoken` adds `iat`, the body no longer matches what SantimPay expects to reconstruct, and
  you get `{"message":"Invalid token","status":"declined"}`. Keep the `JSON.stringify`.
- **Key order does not matter** (it is a JSON object, not a canonicalised string), but **field names
  do**, and they differ per operation. See below.

### 2.1 Signing bodies per operation

| Operation | Signing body fields |
|---|---|
| Initiate payment | `{ amount, paymentReason, merchantId, generated }` |
| Direct payment | `{ amount, paymentReason, paymentMethod, phoneNumber, merchantId, generated }` |
| B2C / payout | `{ amount, paymentReason, paymentMethod, phoneNumber, merchantId, generated }` |
| Transaction status | `{ id, merId, generated }` |

`generated` = **Unix seconds** (`Math.floor(Date.now()/1000)`).

> ⚠️ **Note the trap:** the status-check body uses **`merId`**, every other body uses
> **`merchantId`**. The Additional doc states this explicitly: *"Signed token generated for the check
> transaction api which uses merId instead of merchantId on the signing body."* Get this wrong and
> you get `crypto/ecdsa: verification error`.

> ⚠️ **Vendor SDK discrepancy #2 — a real bug.** In `sendToCustomer()`:
> ```js
> this.generateSignedTokenForDirectPaymentOrB2C(amount, paymentReason, this.merchantId, paymentMethod, phoneNumber)
> ```
> but the function signature is `(amount, paymentReason, paymentMethod, phoneNumber)`. The extra
> `this.merchantId` shifts every argument: `paymentMethod` receives the merchant ID, `phoneNumber`
> receives the actual payment method, and the real phone number is dropped. **Every B2C payout signed
> by the unpatched vendor SDK carries a wrong payload.** Our client fixes this.

### 2.2 Verifying a webhook signature

The callback arrives with header **`Signed-Token`** containing a JWS signed with the shared key.
Verification steps:

1. Derive the **public key** from our EC private key PEM (`crypto.createPublicKey(privateKeyPem)`).
2. `jwt.verify(token, publicKeyPem, { algorithms: ['ES256'] })` — **pin the algorithm**. Never pass
   an array containing `none` or an HMAC algorithm; that is the classic JWT algorithm-confusion
   escalation.
3. Re-parse the payload (it is a JSON *string* body, so `jwt.verify` returns a string — `JSON.parse`
   it).
4. Compare the token's `txnId` / amount against the JSON body. **Header and body must agree**; a
   mismatch means someone replayed a valid signature onto a different body.
5. Enforce freshness against `generated` / `created_at` (reject > 5 min skew) to blunt replay.

---

## 3. API surface

### 3.1 `POST /initiate-payment` — hosted checkout (the primary flow)

Creates a hosted payment page and returns its URL. The customer picks their channel on SantimPay's
page.

**Request**

| Key | Type | Description |
|---|---|---|
| `id` | string | **Our** transaction id. Must be globally unique — this is our idempotency key. |
| `amount` | number | Amount in ETB (major units, decimals allowed) |
| `reason` | string | Shown to the payer on the payment page |
| `merchantId` | string | Issued by SantimPay |
| `signedToken` | string | ES256 JWS, body per §2.1 |
| `successRedirectUrl` | string | Browser redirect target after success |
| `failureRedirectUrl` | string | Browser redirect target after failure |
| `cancelRedirectUrl` | string | Browser redirect target if the payer cancels |
| `notifyUrl` | string | **Our** webhook endpoint (server-to-server) |
| `phoneNumber` | string | Optional; pre-fills the payer's MSISDN. Format `+2519XXXXXXXX` |

**Response** `200` → `{ "url": "https://…" }`. Redirect the browser there.

> The PDF titles page 5 "Generate payment URL" and page 1 of the Additional doc adds "initiate
> payment response (success and errors)" — errors follow the same
> `{"message": …, "status":"declined"}` envelope as §6.

### 3.2 `POST /direct-payment` — channel-direct (no hosted page)

Skips the hosted page: we specify the channel and MSISDN, SantimPay pushes an STK/USSD prompt to the
customer's handset.

Adds `paymentMethod` (a partner id, e.g. `"Telebirr"`) and requires `phoneNumber`. Same
idempotency rules. Use this for a fully in-app checkout where you have already collected the
customer's wallet choice — better conversion, but you own the channel-picker UI and its error states.

### 3.3 `GET /payout/partners` — list B2C partners

`http://services.santimpay.com/api/v1/gateway/payout/partners` returns the available channels and
their ids. **Cache this** (it changes rarely) but refresh daily — a stale partner id yields
`"Payment Method Not Supported"`.

### 3.4 `POST /payout-transfer` — B2C (withdrawal / refund / payout)

Real-time, **debited from the merchant escrow/deposit balance**.

| Key | Type | Description |
|---|---|---|
| `id` | string | Merchant transaction id |
| `clientReference` | string | Additional merchant id; may equal `id` |
| `amount` | double | Money sent to the customer |
| `reason` | string | Transaction reason |
| `merchantId` | string | Merchant id |
| `signedToken` | string | ES256 JWS |
| `receiverAccountNumber` | string | Receiver phone (`+251…`) or bank account |
| `paymentMethod` | string | Id from the partners list |
| `notifyUrl` | string | Callback URL |

Success response carries `"status": "SUCCESS"` and `transactionType: "GATEWAY_PAYOUT"`.

> **Operational reality:** B2C fails when the escrow balance is short. That is a *business* alert,
> not a bug — page the finance owner, not the on-call engineer. See the runbook.

### 3.5 `POST /fetch-transaction-status` — the source of truth

| Key | Type | Description |
|---|---|---|
| `id` | string | Our transaction id from initiation |
| `merchantId` | string | Merchant id |
| `signedToken` | string | Signed with **`merId`** body (§2.1) |
| `fullParam` | boolean | `true` returns the full response set |
| `generated` | number | Unix timestamp |

**This endpoint — not the webhook — is what authorises fulfilment.**

---

## 4. The transaction object

Returned by the status API and posted to `notifyUrl`.

```json
{
  "txnId": "d7fa8146-cb58-405a-8ca7-920cdc1f56da",
  "created_at": "2023-02-28T10:26:17.904879Z",
  "updated_at": "2023-02-28T10:26:49.042602Z",
  "thirdPartyId": "1",
  "merId": "f660f84e-7395-417b-91ff-542026c38326",
  "merName": "santimpay test company",
  "address": "Addis Ababa",
  "amount": "1",
  "currency": "ETB",
  "reason": "Payment for a coffee",
  "msisdn": "",
  "accountNumber": "",
  "paymentVia": "Telebirr",
  "refId": "5e4af4cc-99d1-4db9-a784-4ba4eb75e646",
  "successRedirectUrl": "https://santimpay.com",
  "failureRedirectUrl": "https://santimpay.com",
  "message": "payment successful",
  "status": "COMPLETED",
  "receiverWalletID": ""
}
```

Field reference (merged from both PDFs):

| Field | Meaning |
|---|---|
| `txnId` | SantimPay transaction id |
| `created_at` | When the payment URL was generated |
| `updated_at` | When the channel (Telebirr / Amhara Bank / …) confirmed |
| `thirdPartyId` | **Our** id — the join key back to our `payment_intent` |
| `transactionType` | empty = payment; `"GATEWAY_PAYOUT"` = B2C |
| `merId`, `merName`, `address` | Merchant identity |
| `amount` | Amount **before** commission |
| `commission` | Commission deducted |
| `totalAmount` | Total including commission |
| `currency` | Always `ETB` |
| `reason` | Our reason string |
| `msisdn` | Phone used for the transaction |
| `accountNumber` | Bank account, for bank payments |
| `clientReference` | Our reference (B2C) |
| `payment_via` / `paymentVia` | Channel: Bunna bank, CBE Birr, Telebirr … |
| `ref_id` / `refId` | Transaction id **from the bank/channel** — this is what the customer's bank SMS shows. Store it; support will ask for it. |
| `commissionAmountInPercent` | Commission % |
| `providerCommissionAmountinPercent` | Channel's own commission (Telebirr charges one) |
| `commissionFromCustomer` | Whether commission is passed to the customer — configured at account creation |
| `message` | Human message from the channel |
| `status` | See §4.1 |
| `StatusReason` | Failure reason |
| `RecieverWalletID` | Merchant wallet id *(vendor's spelling — note the typo, match it exactly)* |

### 4.1 Status values

| Status | Meaning | Our action |
|---|---|---|
| `PENDING` | Under approval at the channel | Keep polling; do not fulfil; do not fail |
| `COMPLETED` | Payment successful (all transaction types on the status API) | Fulfil, once |
| `FAILED` | Failed — reason in `message` | Release inventory, tell the customer why |
| `SUCCESS` | **B2C response message only** | Payout accepted |
| `declined` | Request rejected (insufficient balance, wrong IP, bad token) | Do not retry blindly — fix the cause |

> ⚠️ Note the inconsistency: the payment flow terminal-success is `COMPLETED`; the B2C immediate
> response is `SUCCESS`. Normalise both into your own enum at the boundary. Never let a vendor's
> string vocabulary leak into your domain model.

---

## 5. Integration flows

### 5.1 Hosted checkout — the happy path

```
Customer            Our App                 SantimPay            Channel (Telebirr)
   │                   │                        │                       │
   │──place order─────▶│                        │                       │
   │                   │ create Order(PENDING)  │                       │
   │                   │ reserve inventory      │                       │
   │                   │ create PaymentIntent   │                       │
   │                   │   id = ULID (unique)   │                       │
   │                   │──POST initiate-payment▶│                       │
   │                   │◀────── { url } ────────│                       │
   │◀──302 redirect────│                        │                       │
   │──────────── open hosted page ─────────────▶│                       │
   │──────────── choose Telebirr, pay ─────────▶│──────debit request───▶│
   │                   │                        │◀─────confirmation─────│
   │                   │◀── POST notifyUrl ─────│                       │
   │                   │  (verify Signed-Token) │                       │
   │                   │──POST fetch-status────▶│  ← authoritative      │
   │                   │◀──── COMPLETED ────────│                       │
   │                   │ Order → PAID, fulfil   │                       │
   │◀─302 successUrl───│                        │                       │
```

### 5.2 Why the redirect is not proof of payment

`successRedirectUrl` is hit **by the customer's browser**. A customer can:

- type the success URL directly,
- press back and re-trigger it,
- close the tab before the redirect fires (payment succeeded, redirect never happened),
- lose connectivity on mobile data mid-redirect.

**Rule: the redirect updates the UI. It never updates money state.** The success page shows
"confirming your payment…" and polls our own API for the order's real status.

### 5.3 Webhook handling rules

1. **Respond `200` fast** (< 2s) — acknowledge receipt, then process asynchronously. A slow webhook
   endpoint causes gateway-side retries and duplicate processing.
2. **Verify the `Signed-Token` header before parsing anything else.**
3. **Idempotency:** persist `(txnId, status)` with a unique constraint. A repeat delivery must be a
   no-op. Gateways retry; assume at-least-once delivery, always.
4. **Never trust the webhook's `amount`.** Compare it against the stored `PaymentIntent.amount`. A
   mismatch is a security incident: log, alert, do not fulfil.
5. **Order the transitions.** A late `PENDING` must not overwrite an already-`COMPLETED` record. Use
   a state machine with explicit legal transitions, not `UPDATE payment SET status = $1`.

### 5.4 Defence in depth: webhook + poll + reconcile

Three independent paths must converge on the same truth:

| Layer | Trigger | Purpose |
|---|---|---|
| **Webhook** | SantimPay pushes | Fast path — usually resolves in seconds |
| **Poller** | Our worker, backoff 5s→10s→30s→1m→5m for up to 30 min | Covers dropped/blocked webhooks |
| **Reconciler** | Nightly cron over all non-terminal intents older than 1h | Covers everything else; feeds the finance report |

If you build only the webhook, you *will* have stuck orders. This is not pessimism; it is what
happens on Ethiopian mobile networks.

---

## 6. Error catalogue

Errors return HTTP `200` with `"status": "declined"` — **check the body, not just the status code.**

| `message` | Cause | Fix | Retryable |
|---|---|---|---|
| `phone number must be in the format +251912345678` | MSISDN not E.164 | Normalise `09…`/`2519…`/`+2519…` → `+2519…` before sending | No — fix input |
| `ERROR: new row for relation "santimpay_wallets" violates check constraint "chk_santimpay_wallets_balance_is_non_negative" (SQLSTATE 23514)` | B2C payout exceeds escrow balance | Top up merchant escrow | No — business action |
| `Payment Method Not Supported` | Wrong/stale partner id | Refresh `/payout/partners` | No |
| `Invalid token` | Signing body malformed — usually `iat` auto-injected, or wrong field names | Keep `JSON.stringify`; check `merId` vs `merchantId` | No |
| `crypto/ecdsa: verification error` | Wrong private key, or key/environment mismatch (testbed key against prod) | Verify key ↔ environment pairing | No |
| `Duplicate Client Reference.` | `id`/`clientReference` reused | **Treat as success-in-progress**, not failure — look the original up via status API | No — but not an error either |

> The raw Postgres constraint error leaking through the API is a good lesson in what *not* to do in
> your own error design. Map upstream errors to a stable, documented taxonomy at your boundary —
> §"Anti-corruption layer" in the integration curriculum.

---

## 7. Production readiness checklist

- [ ] Private key stored in a secret manager; never in git, never in an image layer, never logged
- [ ] Separate keys + merchant ids per environment; the app refuses to boot if prod URL + test key
- [ ] Gateway bearer token sent on every request
- [ ] `notifyUrl` is HTTPS, publicly reachable, and **not** behind Basic Auth or IP allowlists that
      exclude SantimPay
- [ ] Source IP allowlist confirmed with SantimPay ops for B2C ("wrong ip" is a documented decline)
- [ ] Webhook signature verification enforced; unsigned webhooks rejected with `401`
- [ ] Every payment intent has a globally unique `id` (ULID), generated once and persisted **before**
      the outbound call
- [ ] Amount comparison on every callback
- [ ] Poller + nightly reconciler running with alerting on stuck intents
- [ ] `refId` and `txnId` persisted and surfaced in the admin UI for support
- [ ] Commission fields captured for finance (`commission`, `totalAmount`, `commissionFromCustomer`)
- [ ] Runbook written for: stuck PENDING, escrow depleted, key rotation, webhook outage
- [ ] Load-tested: hosted-page redirect path at expected peak; status API rate limits confirmed

---

## 8. Open questions for SantimPay ops

Ask these in the integration group **before** go-live. Their absence from the PDFs is itself a
finding:

1. **Webhook retry policy** — how many times, what backoff, what response codes trigger retry?
2. **Rate limits** on `fetch-transaction-status` — our poller must respect them.
3. **Source IPs** SantimPay calls `notifyUrl` from, for allowlisting.
4. **Refund semantics** — is B2C the only refund mechanism, or is there a reversal API tied to the
   original `txnId`?
5. **Partial capture / authorisation hold** — supported at all? (Assume no; design for
   capture-on-payment.)
6. **Settlement timing** — when does an escrow credit become withdrawable?
7. **Key rotation procedure** and expected downtime.
8. **`fullParam`** — exact field-set difference vs. the default response.

---

*Next: `02-integration-engineering.md` — the general theory this specific gateway is one instance of.*
