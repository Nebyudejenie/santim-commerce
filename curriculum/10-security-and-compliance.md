# Phase 10 — Security & Compliance

*Same method as Phases 1–9: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. This phase pulls together security work spread
across nine earlier phases — Phase 2's webhook verification, Phase 5's non-root containers, Phase
8's NetworkPolicy — into one coherent threat model, and adds what's genuinely new here: identity,
secrets end to end, and the honest boundary between "well-engineered" and "compliant," which are
not the same claim.*

---

## Why this phase exists

Security work that's scattered across a codebase, each piece locally reasonable, is not the same
thing as a *considered posture* — the difference is whether anyone has stepped back and asked "what
is this system actually defending against, as a connected whole." This phase does that step-back
explicitly, using STRIDE and OWASP as the two lenses, then covers the two things a scattered
security review usually misses: identity (who is this request from, really) and the specific,
narrow, real question of what compliance requires *on top of* good engineering — because they
are genuinely different questions, and conflating them is how a well-built system still fails an
audit.

---

## 1. STRIDE, applied to checkout specifically — not as a generic checklist

STRIDE names six threat categories; the value is in applying each one to a *specific* flow and
asking what this codebase actually does about it, not reciting the acronym.

| Threat | Concretely, for checkout | This codebase's real answer |
|---|---|---|
| **S**poofing | An attacker claims to be SantimPay, sending a fake webhook | `verifyES256` + algorithm pinning (Phase 2 §2.3) — the token's own `alg` header is never trusted |
| **T**ampering | A captured, valid webhook is replayed onto a different order's body | `assertClaimAgrees()` binding the signature to *this specific body* (Phase 2 §2.4) |
| **R**epudiation | A customer disputes a charge; no record of what actually happened | `OrderEvent`'s append-only audit trail (Phase 3 §8) — every state transition, with actor and raw gateway data |
| **I**nformation disclosure | A leaked log line hands over a session token or private key | `logger.ts`'s centralized redaction (Phase 9 §1.1) — every field, every call site, one place |
| **D**enial of service | A flood of checkout attempts exhausts the connection pool or SantimPay's own patience | Partial — retry/backoff with full jitter (Phase 1 §7.1) protects the *gateway*; nothing yet protects *this app's* own endpoints (§5 below) |
| **E**levation of privilege | A CUSTOMER-role session reaches `/admin` | `requireRole()` (§2.2 below), checked at the top of every protected layout, before any child renders |

**Five of six categories have a real, specific, already-built answer.** The sixth — denial of
service against this application's *own* endpoints, as opposed to protecting the *gateway* from
this application's own retry behavior — is a genuine, current gap, and it's the same gap §5
addresses directly: nothing in this codebase rate-limits an inbound request.

---

## 2. AuthN/AuthZ: sessions over JWT, and why, precisely

### 2.1 Database-backed sessions — the actual tradeoff, not just a preference

`schema.prisma`'s `Session` model comment states the reasoning already, and `session.ts`'s own
comment restates the mechanism precisely:

> TOKEN HANDLING RULE, stated once so every call site can be trusted to follow it: the RAW token
> exists only in the cookie and in-memory, for the instant it's generated. The DATABASE only ever
> sees `sha256(token)`. A dump of the sessions table is therefore useless to an attacker — this is
> the identical principle applied to the SantimPay private key never appearing in logs, and to WHY
> `Signed-Token` verification is timing-safe.

**The real tradeoff, stated precisely rather than "JWT is bad":** a stateless JWT's entire appeal
is not needing a database round-trip to verify a session — at the cost that revoking one is
structurally hard (you either wait out the token's own expiry, or maintain a blocklist, which is
just a database-backed session check wearing a disguise). For a payments-adjacent app, "revoke this
session right now" — a compromised account, a stolen device — needs to be instant and
unconditional. A `DELETE FROM sessions WHERE id = ...` gives that. A JWT's stateless-by-design
property is precisely the property this specific threat model can't afford.

### 2.2 RBAC — a rank, not a set of special cases

```ts
/** Role hierarchy for the admin gate: ADMIN can do everything STAFF can. */
const ROLE_RANK: Record<UserRole, number> = { CUSTOMER: 0, STAFF: 1, ADMIN: 2 };

export function hasRole(role: UserRole, required: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
```

A numeric rank, not a per-role special case scattered through every protected route — adding a
fourth role later (say, `SUPPORT`, between `CUSTOMER` and `STAFF`) means inserting one line into
`ROLE_RANK`, not auditing every `if (role === "ADMIN" || role === "STAFF")` in the codebase for
whether it should also now include the new role. `guard.ts`'s `requireRole()` is the one function
every protected surface calls:

```ts
export async function requireRole(minRole: UserRole): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || !hasRole(user.role, minRole)) {
    redirect("/admin/login");
  }
  return user;
}
```

**Where this runs, and why that placement is itself a real security decision:** `guard.ts`'s own
comment explains why authorization lives in a layout's Server Component rather than in
`middleware.ts`, which is where a Next.js project's authorization often defaults to living:

> These run in the Node.js runtime... where Prisma works normally — unlike `middleware.ts`, which
> runs on the Edge runtime by default and cannot talk to Postgres without extra infrastructure
> (Prisma Accelerate / a driver adapter) this project doesn't have.

Placed in `(dashboard)/layout.tsx`, `requireRole()` runs before any child route renders — Next.js
Server Components execute a layout's own logic before any nested page's, so an unauthorized request
never reaches the code that would query orders, payments, or reconciliation data at all. **The
lesson:** the "obvious" place to put an auth check (middleware, request-entry-point) isn't
automatically correct if that layer can't actually perform the check your specific system needs —
here, a database-backed session check that Edge middleware structurally can't do without additional
infrastructure this project doesn't have. Choosing the *correct* enforcement point mattered more
than choosing the conventional one.

### 2.3 Password hashing — a deliberate, reasoned non-default choice

`password.ts`'s own header explains choosing `scrypt` (Node's built-in, via `node:crypto`) over the
more commonly recommended `bcrypt`/`argon2`:

> Both ship as native addons requiring compilation (`node-gyp`) — which means a C toolchain in
> every environment that runs `pnpm install`, including this project's multi-stage Docker build...
> and a matching prebuilt binary for whatever exact Node/OS/arch combination each environment
> happens to be. `scrypt` is a memory-hard KDF built into Node itself: OWASP-acceptable, zero extra
> dependencies, zero native-binding fragility.

This is Phase 5's own concerns — a reproducible, minimal, `node-gyp`-free Docker build — directly
shaping a security decision three phases later, not a coincidence: `hashPassword`/`verifyPassword`
being the only two functions the rest of the app ever calls means swapping to Argon2id later (OWASP's
current first choice, and the comment says so directly) touches exactly one module, nothing else.

**The KDF parameters travel with the hash, not with the code:**

```
scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
```

`needsRehash()` compares a stored hash's embedded parameters against `CURRENT_PARAMS`, so tuning
the cost factor upward later (as hardware gets faster — the entire reason a KDF has a cost
parameter at all) doesn't invalidate every existing password; a user's *next successful login*
transparently re-hashes under the new parameters. A max-length check on the password itself is
present for a reason worth noting precisely — *not* a strength rule:

```ts
if (password.length > 256) {
  // Not a strength rule — a bound on how much CPU an attacker can make us
  // spend hashing an absurdly long string on a public registration form.
  throw new PasswordError("Password is too long.");
}
```

An unauthenticated registration form calling a deliberately expensive (memory-hard, ~50-100ms) KDF
on attacker-supplied input is real DoS surface — Phase 1's own STRIDE row above, closed here, one
specific place at a time.

### 2.4 Timing-safe login — closing the gap a correct error message alone doesn't

`auth-service.ts`'s `login()` comment states the *two-part* defense against account enumeration
directly:

> SAME ERROR FOR "no such user" AND "wrong password" — distinguishing them lets an attacker
> enumerate which emails have accounts, one login attempt at a time. The dummy-hash comparison
> below also keeps the TIMING the same in both cases: without it, "no such user" returns
> near-instantly while "wrong password" takes ~50-100ms (scrypt's cost), and that gap alone is
> enough to enumerate accounts even with an identical error message.

```ts
const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
const valid = await verifyPassword(input.password, hashToCheck);
```

An identical error message is the defense most implementations stop at — and it's insufficient on
its own, because the *response time* itself leaks the same information a differently-worded error
would have. `DUMMY_HASH` — a real, well-formed scrypt hash of a password nobody has ever entered,
generated via the real `hashPassword()` code path rather than typed by hand as hex — exists purely
so an unknown email still pays the same ~50-100ms scrypt cost a real wrong-password check would,
closing the timing side-channel a correct-looking error message alone leaves wide open. **The
generalizable lesson:** a security defense stated only in terms of what the *response says* is
half the defense; what the response *costs*, in time, is frequently the other half, and it's the
half that's easy to forget entirely.

---

## 3. Webhook security — already built, referenced here as part of the coherent posture

Phase 2 §§2 and 5 already covered this in full depth: algorithm-pinned ES256 verification, the
5-minute replay window, claim-to-body binding, and the FAST/HONEST/PARANOID/RAW contract. Restated
here only to place it correctly within this phase's STRIDE table (§1) — the webhook receiver is
this codebase's single highest-value target (Phase 2's own framing: the private key
*authenticates both directions*, so a compromise here isn't "read access to a webhook," it's
"impersonate SantimPay itself, to yourself") and it's the one surface this project treats with the
most defense-in-depth of anything in the codebase: signature verification, THEN claim-body
agreement, THEN an authoritative status-API re-check before any state changes at all (Phase 2 §5's
"never trust the webhook body, only that it tells you to go check").

---

## 4. Secrets management, end to end — and the one real question left unanswered

The full chain, each link already covered in an earlier phase, worth reading as one continuous
path rather than separate facts: a developer's local `.env` (kept out of the Docker build context
by Phase 5 §5's `.dockerignore`) → `secret.yaml`'s committed **template**, explicitly never the
real source of truth (Phase 5 §6) → in a real environment, External Secrets Operator or Sealed
Secrets populating the actual `Secret` object (Phase 5 §6, Phase 8 §4) → `env.ts`'s boot-time
validation, refusing to start on missing or contradictory configuration rather than discovering the
gap when the first real payment attempt hits it (Phase 2 §§Lab-2.5).

**Rotation without downtime — the one real question this chain doesn't yet answer.**
`docs/runbooks/03-key-rotation.md` exists and documents the *procedure* for rotating the SantimPay
private key specifically — but the private key is uniquely awkward to rotate for a reason worth
being precise about: it's not purely this application's own secret. SantimPay holds a copy too
(Phase 2 §2's framing — the same key authenticates outbound requests *and* verifies inbound
webhooks), so rotating it requires coordinating with SantimPay's own onboarding process, not just
updating a Kubernetes `Secret` and restarting pods. `SESSION_SECRET` and `METRICS_TOKEN`, by
contrast, are purely this application's own — rotating either is a "update the Secret, roll the
Deployment" operation this codebase's own rolling-update strategy (Phase 8 §3, `maxUnavailable: 0`)
already handles without downtime, though no runbook documents that specific procedure the way
`03-key-rotation.md` documents the private key's.

---

## 5. Rate limiting, bot defence, card-testing/enumeration defence — a real, current gap

Grep this entire codebase for rate limiting and there's nothing there — no middleware, no
per-IP/per-account throttle, on any endpoint. This is a real gap, not a considered "not yet" the
way Phase 8's service-mesh absence was — nothing in this codebase's comments reasons through why
it's missing, it simply isn't built.

**Made concrete, for the two surfaces where it matters most:**

- **`login()` (§2.4)** — the timing-safe, enumeration-resistant comparison closes the *side-channel*
  a naive implementation would leak, but does nothing to slow down an attacker attempting many
  passwords against one account, or one password against many accounts, at whatever rate the
  server can process requests. A rate limit here is the actual defense against brute force; the
  timing-safe comparison only ensures each individual attempt doesn't leak extra information.
- **`startPayment()` (Phase 2 §3)** — "card-testing" in payments specifically means an attacker
  running many small, automated payment attempts to test a list of stolen card/account
  credentials, using a real merchant's checkout as the oracle. This codebase's `startPayment()` has
  no per-customer, per-IP, or per-order-rate throttle on how often a payment attempt can be
  initiated — it correctly *reuses* an in-flight intent on a double-click (Phase 2 §3), but nothing
  stops a scripted, rapid sequence of *new* checkout attempts.

---

## 6. PCI DSS SAQ-A — why this architecture's shape is the actual compliance answer

**The core fact worth understanding precisely, not just citing:** PCI DSS scope is determined by
where card data flows *through your own systems*, not by whether you accept card payments at all.
This codebase's checkout flow (Phase 2 §5.1's real sequence diagram) never receives a card number,
a CVV, or any raw payment credential at any point — the customer is redirected to SantimPay's own
hosted checkout page, enters payment details *there*, on SantimPay's own infrastructure, and this
application only ever receives a `merchantTxnId`, a status, and a signed webhook confirming what
happened. **That architectural fact — not a policy decision, a structural one, forced by using a
redirect-based hosted checkout rather than embedding a card form — is what makes SAQ-A (the
simplest, shortest PCI DSS self-assessment questionnaire) the right category, rather than the far
heavier SAQ-D that applies to a merchant whose own servers ever touch raw card data.**

**What SAQ-A still genuinely requires, that this document won't invent unfounded claims about:**
confirming the redirect mechanism itself can't be tampered with to point at an attacker-controlled
page (real, and covered — `createCheckoutSession()`'s `assertHttps()` on the notify URL, Phase 2's
signing discipline on the request that generates the redirect itself), and organizational
requirements (a signed Attestation of Compliance, security awareness policies, incident response
documentation) that are about the *organization*, not the codebase, and are genuinely outside what
a curriculum grounded in reading source code can assess for you. **The Ethiopian regulatory
equivalent** — NBE (National Bank of Ethiopia) directives governing payment service providers and
their merchants — is real and relevant, and specifically outside this document's ability to state
authoritatively: unlike PCI DSS (an internationally standardized, publicly documented framework this
document can reason about structurally), the current NBE requirements applicable to a specific
merchant category are a real regulatory question deserving a real answer from Ethiopian legal/
compliance counsel, not a plausible-sounding paragraph in a curriculum document.

---

## 7. Data protection: what's real, and what's genuinely unaddressed

**PII minimization and protection in transit/at logging time** — real, and already covered in
depth: `logger.ts`'s redaction (Phase 9 §1.1), MSISDN partial masking, secret-field wholesale
redaction. **Encryption in transit** — real at the edges covered so far: TLS termination at the
Ingress (Phase 5 §6, Phase 8 §3), `env.ts`'s refusal to boot with a non-HTTPS `APP_URL` outside
development (Phase 2 Lab 2.5), `sslmode=require` in the database connection template (Phase 7 §0).
**Encryption at rest** — genuinely unaddressed *by this codebase*, because it's not this
codebase's layer to address: whether Postgres's underlying storage is encrypted at rest is a
property of *where* it's actually hosted, which Phase 7 §0 already established this project has
never decided.

**Retention and right to erasure — a real, current, and not-yet-reasoned-about gap.** Nothing in
this schema expresses a retention policy for `OrderEvent` (Phase 3 §8's permanent audit trail),
`WebhookEvent` (Phase 2's forensic record, explicitly never deleted per its own schema comment), or
`Session` rows beyond expiry-driven cleanup (`session-store.ts`'s `purgeExpiredSessions()`, called
from the worker's own reconcile loop — Phase 2 §6 — which reclaims *expired* sessions, not a
customer's *data* on request). A real "delete my account and everything
tied to it" request — increasingly a legal requirement, not just a nice-to-have, in many
jurisdictions' data protection law — would today mean manually reasoning through every table with
a `userId` or `email` foreign key and deciding, table by table, whether to hard-delete, anonymize,
or retain for a legally-justified reason (a completed order's financial record, for instance, often
has its own mandatory retention requirement that's in tension with an erasure request — resolving
that tension is a real legal question, not an engineering one). None of that reasoning has been
done yet in this codebase.

---

## 8. Container/K8s hardening — comprehensive at the pod level, unenforced at the cluster level

`deployment-web.yaml`'s security posture is genuinely thorough — worth reading as one deliberate
set, not scattered defaults:

```yaml
# pod-level
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
```
```yaml
# container-level — the comment states the reasoning directly:
# "no capabilities, no privilege escalation. None of this app's
# code needs to write outside /tmp."
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
```

Non-root (Phase 5 §2.1) plus a *read-only root filesystem* — a step further than non-root alone —
plus every Linux capability explicitly dropped, plus the default (not custom, not disabled) seccomp
profile filtering available syscalls. `readOnlyRootFilesystem: true` means even a successful code
injection inside this container cannot write a new file to disk anywhere except the two explicitly
mounted, narrow exceptions (`/tmp`, the Next.js cache directory) — a real, structural constraint on
what a compromise can do next, not just a policy statement.

**What's real here individually, and what's missing to make it a backstop instead of a
convention:** every one of these settings would very likely satisfy the Kubernetes "restricted" Pod
Security Standard if it were actually being checked — but `namespace.yaml` carries no
`pod-security.kubernetes.io/enforce` label, and no OPA Gatekeeper or Kyverno policy exists anywhere
in `infra/`. **The precise gap:** nothing currently *stops* a future change from silently regressing
one of these settings — dropping `readOnlyRootFilesystem: true` to work around some new feature's
need to write a file, say — and having that change pass code review by a reviewer who doesn't
happen to notice the removed line. Admission-time enforcement is what turns "this is how we
configure things" into "this cannot be deployed any other way," and that step hasn't been taken.

---

## 9. OWASP Top 10, mapped to this specific codebase

Rather than restate the list generically, map each category to where this codebase's own defense
actually lives — a "does this apply, and where" table is more useful than an abstract description:

| OWASP category | This codebase's real answer |
|---|---|
| Broken Access Control | `requireRole()`/`requireUser()`, checked before any protected render (§2.2) |
| Cryptographic Failures | scrypt (§2.3), ES256 with pinned algorithm (Phase 2 §2.3), TLS-only in deployed environments (§7) |
| Injection | Parameterized queries throughout (Prisma; the one raw SQL statement, Phase 3 §2.1's reservation UPDATE, is fully parameterized despite being raw) |
| Insecure Design | The whole of Phases 1–3's architecture — idempotency, state machines, the reservation atomicity proof — *is* this category's positive answer |
| Security Misconfiguration | §8's pod-level hardening real; §8's admission-time enforcement absent |
| Vulnerable/Outdated Components | Phase 6 §5's real, lived CVE-triage story — the most concretely-exercised item on this entire list |
| Identification/Authentication Failures | §§2.1, 2.4 — DB-backed sessions, timing-safe dummy-hash login |
| Software/Data Integrity Failures | Cosign keyless signing, digest-pinned deploys (Phase 6 §6) |
| Security Logging/Monitoring Failures | Real (Phase 9), with the one honest gap already named there — no aggregation, no traces |
| Server-Side Request Forgery | Not directly applicable — this app makes exactly one class of outbound third-party call (SantimPay's API), to a fixed, configured host, never to a URL derived from user input |

**Nine of ten categories have a specific, real, already-built answer somewhere in this codebase.**
The tenth (SSRF) is a case of the vulnerability class genuinely not applying to this architecture's
actual shape — worth stating plainly rather than searching for a defense against a threat that
isn't present, which is its own kind of dishonesty about what's actually been secured.

---

## Labs

### Lab 10.1 — Reproduce the login-timing side channel, then close it

Comment out the `DUMMY_HASH` fallback in `login()` so an unknown email skips the scrypt comparison
entirely. Measure response time for a known-wrong-password attempt versus an unknown-email attempt
— confirm a real, measurable gap (tens of milliseconds, consistent with scrypt's own cost).
Restore the dummy-hash comparison and confirm the gap closes to noise. This is the concrete version
of §2.4's claim, timed for real rather than taken on faith.

### Lab 10.2 — Add real rate limiting, and prove it changes the actual attack cost

Implement a per-IP or per-account rate limit on `login()` and `startPayment()` (§5) — Redis-backed
sliding window, or an in-memory token bucket if you're comfortable with its single-instance
limitation. Script a rapid sequence of login attempts against a known account before and after;
confirm the attempt rate is genuinely bounded, not just logged. Then discuss, concretely: what
does this NOT protect against that a distributed attack (many source IPs) would still get through,
and what would actually close that gap (this is a real, open design question, not one with an
easy answer this document will supply).

### Lab 10.3 — Enforce what §8 found unenforced

Add a `pod-security.kubernetes.io/enforce: restricted` label to `namespace.yaml`, or write a
Kyverno `ClusterPolicy` requiring `readOnlyRootFilesystem: true` and `capabilities.drop: ["ALL"]`
on every pod in the `santim-commerce` namespace. Deliberately regress `deployment-web.yaml` (remove
`readOnlyRootFilesystem`) and confirm the admission controller now rejects the deploy outright,
rather than silently accepting a weaker configuration the way a plain `kubectl apply` would.

### Lab 10.4 — Design the erasure path §7 found missing

Enumerate every table with a `userId` or `email` reference (`schema.prisma`). For each one, decide
and justify: hard delete, anonymize in place, or retain with a documented legal reason (a completed
`Order`'s financial record is the interesting case — work out what a defensible retention
justification actually looks like, not just "keep everything to be safe"). Write the actual
migration/service function implementing your design for at least the two clearest cases.

---

## Gate — do not proceed to Phase 11 until you can do this cold

1. **Why is a database-backed session structurally better suited to this project's threat model
   than a stateless JWT, specifically?** (Instant, unconditional revocation — "log this device out
   right now" for a compromised account or lost phone — which a stateless-by-design JWT can only
   approximate via a blocklist, which is a database-backed session check by another name.)
2. **An identical login error message for "wrong password" and "no such user" is necessary but not
   sufficient to prevent account enumeration. What's the other half of the defense, and why does it
   matter?** (Response *timing* — a real password check costs real scrypt computation time an
   unknown-email check would otherwise skip; the dummy-hash comparison closes that timing
   side-channel, which an identical error message alone leaves fully exploitable.)
3. **Why does this codebase's checkout flow qualify for PCI DSS SAQ-A rather than a heavier
   category, and is that a policy choice or a structural fact?** (Structural — card data is entered
   on SantimPay's own hosted page, never received by this application's own servers at any point;
   using a redirect-based hosted checkout rather than an embedded card form is what puts card data
   out of this codebase's PCI scope, not a decision made after the fact.)
4. **This codebase's pod security settings would likely satisfy Kubernetes' "restricted" Pod
   Security Standard. Why isn't that itself sufficient?** (Nothing currently enforces it at
   admission time — a future change can silently regress `readOnlyRootFilesystem` or a dropped
   capability and still deploy successfully, passing code review if a reviewer doesn't happen to
   notice. Good configuration and enforced configuration are different guarantees.)
5. **Name the one OWASP Top 10 category this document concluded doesn't meaningfully apply to this
   architecture, and explain why concluding "not applicable" honestly is different from having no
   answer.** (SSRF — this app makes exactly one class of outbound call, to a fixed, configured
   host, never derived from user input; stating that plainly, with the reasoning, is a real answer
   to the category, not an omission.)

---

*Next: `11-scale-and-resilience.md` — Phase 11: the load-testing suite's real k6 scripts, the
chaos drills' actual measured results, and what this codebase has and hasn't proven about its own
behavior under load.*
