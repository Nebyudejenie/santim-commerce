# Phase 6 — CI/CD & Software Supply Chain

*Same method as Phases 1–5: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. This phase is different from the others in one
way worth naming up front: most of it is a first-hand account. `ci.yml` was not green when this
curriculum started being written — getting it there took five real, sequential bugs, each found
and fixed with live verification against actual GitHub Actions runs, not assumed. This phase also
found and fixed a sixth, more serious gap in `deploy.yml` while being written: migrations were
never actually being waited on before new code rolled out. Both the finding and the fix are below,
not smoothed over.*

---

## Why this phase exists

A CI/CD pipeline that "should work" and one that's actually been watched turn green, end to end,
against real infrastructure, are different things — and the gap between them is usually invisible
until the day it isn't. Everything in this phase is reconstructed from what it actually took to
close that gap on this specific project, because a curriculum that only shows the *final*,
working `ci.yml` teaches you what correct looks like without teaching you what broken looks like on
the way there — and broken-on-the-way-there is what you'll actually encounter.

---

## 1. Pipeline stages, and why the order is front-loaded

`ci.yml`'s own header states the ordering principle directly:

> Stage order is deliberate and front-loaded with the cheapest checks: typecheck/lint (seconds) →
> unit tests (seconds) → integration tests against real Postgres (~1 min) → build + scan the actual
> container image (~2 min). A broken import fails in 20 seconds here, not after a 3-minute Docker
> build.

Four real jobs, in this exact order, with `needs:` encoding the dependency: `quality` (typecheck,
lint, unit tests) → `integration` (needs `quality`; real Postgres service container) → `build`
(needs `quality`; Docker build, Trivy scan, SBOM) → `ci-required` (needs all three, `if: always()`,
fails if any upstream job failed or was cancelled). `deploy.yml` picks up from there on a version
tag: `build-and-push` (build, sign) → `deploy` (apply manifests, roll out, wait, rollback on
failure) — covering the remaining lint→...→scan→sign→deploy stages the master plan names, split
across the two workflows because they run on different triggers (Phase 2's own reasoning: "push to
main" and "money-moving code went to production" must never be the same event).

### 1.1 `ci-required` — one stable target for branch protection

```yaml
ci-required:
  name: CI required checks
  runs-on: ubuntu-latest
  needs: [quality, integration, build]
  if: always()
  steps:
    - name: Fail if any required job failed
      if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
      run: exit 1
```

The comment above this job names the exact problem it solves: *"A single job every branch-
protection rule can point at, regardless of how the matrix above evolves — adding a job later
means adding it to `needs` here once, not re-editing every repo's required-checks setting."*
Without this indirection, a repo's branch-protection rule would need to list `quality`,
`integration`, and `build` individually as required checks — and every time a new job is added to
`ci.yml`, someone has to remember to *also* go update the branch-protection settings in the repo's
own UI, a step that's easy to forget and has no CI of its own to catch the omission. One job,
`ci-required`, is the only thing branch protection ever needs to reference; its own `needs:` list
is what actually has to grow.

---

## 2. Caching, at three different layers, for three different reasons

This codebase caches in three genuinely different places, each solving a different repeated cost:

```yaml
# ci.yml — actions/setup-node@v4
with:
  node-version: ${{ env.NODE_VERSION }}
  cache: pnpm
```
Caches the **pnpm content-addressable store** between CI runs on GitHub's own runner cache —
without this, every `pnpm install --frozen-lockfile` downloads every package from the registry
fresh, every run.

```dockerfile
# Dockerfile, deps stage
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile
```
A **BuildKit cache mount** — persists the pnpm store *inside Docker's own build cache*, separate
from the GitHub Actions runner cache above and from Docker's normal layer cache. This one survives
even when the `deps` layer itself gets invalidated (a lockfile change), because the mount is keyed
independently of the layer — pnpm still has to re-resolve, but it doesn't have to re-download
every package from the network to do it.

```yaml
# ci.yml — docker/build-push-action@v6
with:
  cache-from: type=gha
  cache-to: type=gha,mode=max
```
**Docker layer caching**, stored in GitHub Actions' own cache backend — this is what makes the
`deps` stage from Phase 5 §1 actually skippable between CI runs when the lockfile hasn't changed,
not just within a single build.

**Three layers, three different things being avoided:** re-downloading packages from the registry
(setup-node's cache), re-downloading packages *during a Docker build specifically* even across
otherwise-cold layer caches (the BuildKit mount), and re-running entire Docker build stages whose
inputs haven't changed at all (the GHA layer cache). Skipping any one of the three still leaves the
other two doing real work; they're not redundant with each other.

---

## 3. Deploy strategy: rolling, and specifically why not the others yet

`infra/k8s/base/deployment-web.yaml` configures a `RollingUpdate` with a deliberately asymmetric
setting:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    # Never fewer than current capacity during a deploy — a payment page
    # returning 503 because we scaled down before scaling up is a
    # self-inflicted outage during routine maintenance.
    maxUnavailable: 0
    maxSurge: 1
```

`maxUnavailable: 0` means Kubernetes is never allowed to drop below the current replica count
while rolling — it must bring up new pods (`maxSurge: 1` — one extra at a time) *before* removing
old ones, trading a brief moment of running one pod over capacity for never running one pod under
it. For a payment page, that's the correct trade: a customer mid-checkout during a routine deploy
should never notice one happened.

**Why not blue/green, canary, or feature flags — worth reasoning through, not just naming as more
advanced:**
- **Blue/green** (two full environments, cut traffic over atomically) buys an instant, clean
  rollback at the cost of running double the infrastructure during every deploy. This project's
  actual rollback path (`kubectl rollout undo`, §5 below) already gives a fast, automated revert
  without paying for a permanently duplicated environment — blue/green earns its cost once a
  rolling rollback's few-seconds-to-minutes window is itself unacceptable, which a routine
  e-commerce deploy generally isn't.
- **Canary** (route a small percentage of real traffic to the new version before a full rollout)
  needs request-level traffic splitting this project has no infrastructure for yet — no service
  mesh, no weighted routing at the Ingress. It's the right next step *specifically once* rolling
  updates plus good readiness probes stop catching enough real-world regressions on their own —
  not a default to reach for before that's demonstrably true.
- **Feature flags** (ship the code dark, activate behavior separately from deploying it) solve a
  *different* problem than deploy strategy — they decouple "this code is running" from "this
  behavior is live," which matters most for gradual, reversible *business logic* rollouts. Nothing
  in this checkout/payment flow currently needs that decoupling; every change so far has been
  correctness-critical enough that "reviewed, merged, deployed, live" is the right cadence.

**The rule this teaches:** deploy strategy sophistication should track a real, specific pain the
current strategy is causing — not get adopted because it's the more impressive-sounding option.
Rolling-with-`maxUnavailable:0` is a genuinely correct choice here, not a placeholder waiting to be
replaced.

---

## 4. Database migrations in CI/CD — the gap this phase found and fixed

`infra/k8s/base/job-migrate.yaml`'s own comment states the intended sequence unambiguously:

> Wire this into the deploy pipeline as: apply this Job, `kubectl wait --for=condition=complete`,
> THEN roll the Deployments — never in parallel with them.

And `infra/k8s/README.md` claims this is already true: *"`.github/workflows/deploy.yml` automates
exactly this sequence."* **Reading the actual `deploy.yml` that existed when this phase started
being written, that claim was false.** The `deploy` job applied manifests, then went straight to
`kubectl set image` on the Deployments and waited on *their* rollout — with no
`kubectl wait --for=condition=complete job/...` step anywhere in the file. Nothing was structurally
stopping the web and worker Deployments from rolling out new code before a migration this exact
release depended on had actually finished applying.

Two compounding problems made this worse than "just add the missing `kubectl wait` line":

**1. A Job's pod template is immutable once created.** Unlike a Deployment, which is *designed*
for `kubectl set image` to trigger a fresh rollout, Kubernetes rejects any attempt to change an
existing Job's `spec.template` at all. Re-running `kubectl apply -k` on a second deploy, with the
Job's name unchanged, wouldn't update the previous run's Job to the new release's migrations — it
would either fail outright or (if nothing in the spec differs, which it wouldn't, since the base
manifest hardcodes a placeholder image) silently do nothing, meaning migrations for a given release
might never actually run via this path at all.

**2. The Job's image was a hardcoded, wrong placeholder.** `ghcr.io/example-org/santim-commerce:latest`
— a fictional org, and a mutable tag, in a pipeline whose Deployments get their image from the
*exact digest this specific build produced*, via `kubectl set image` after the fact. But `kubectl
set image` cannot rescue the Job the same way, precisely because of problem #1 — there is no
"after the fact" for a Job's image once it exists.

### 4.1 The fix, applied to this repository

```yaml
# .github/workflows/deploy.yml — the deploy job
- name: Apply manifests
  run: |
    kubectl delete job/santim-db-migrate -n santim-commerce --ignore-not-found
    kubectl kustomize infra/k8s/overlays/production \
      | sed "s|ghcr.io/example-org/santim-commerce:latest|${{ needs.build-and-push.outputs.image }}@${{ needs.build-and-push.outputs.digest }}|g" \
      | kubectl apply -f -

- name: Wait for migrations
  run: kubectl wait --for=condition=complete job/santim-db-migrate -n santim-commerce --timeout=300s
```

Delete-then-recreate sidesteps the immutability problem entirely — rather than trying to patch an
existing Job (impossible for the fields that matter) or invent a per-release unique name (real,
but adds real complexity for a Job whose own `ttlSecondsAfterFinished: 3600` already treats every
run as short-lived — nothing was gained by keeping a longer-lived name around). Piping the rendered
manifests through a `sed` substitution for the exact digest this build produced — *before* they're
ever applied — is what actually gets the correct image into the Job, since that's the only point
in its lifecycle where its image can be set at all. The Deployments pick up the same digest this
same way now too, which makes the pre-existing `kubectl set image` step for them redundant — kept
anyway, since it costs nothing (a `kubectl set image` matching what's already running triggers no
new rollout) and is the one step that stops silently doing nothing if a future change ever
decouples the Job's and the Deployments' image sources again.

**Verified as far as this environment allows:** `kubectl kustomize infra/k8s/overlays/production`
piped through the exact `sed` substitution above was run for real, locally, against this
repository's actual manifests (not a mock) — confirmed all three image references (the Job, both
Deployments) get rewritten correctly, and the resulting YAML is valid. What couldn't be verified
here is the full live sequence against a real cluster — this environment has no cluster to deploy
to, the same limitation noted honestly when the GHCR-lowercase bug (§5.3 below) was fixed earlier
in this same file's history.

---

## 5. The five real bugs it took to get `ci.yml` green

Reconstructed from the actual commit history, in order. Each was found by reading the *specific*
error GitHub Actions produced — never guessed, never fixed speculatively.

### 5.1 "Multiple versions of pnpm specified"

`ci.yml` originally passed an explicit `version:` input to `pnpm/action-setup@v4` *in addition to*
`package.json`'s `"packageManager": "pnpm@10.32.1"` field — which the same action also reads
automatically. Two sources of truth for the same setting, and the action refused to guess which
one won. Fixed by deleting the redundant `version:` input, leaving `packageManager` as the single
source of truth — `ci.yml`'s own comment on this now states the lesson directly: *"Passing an
explicit `version:` input here TOO produced a real, caught-in-production failure... One source of
truth, not two."*

### 5.2 `Module '"@prisma/client"' has no exported member 'PrismaClient'`

Typechecking failed on a genuinely fresh checkout, despite passing on every local development
machine. Root cause: pnpm blocks dependency lifecycle/postinstall scripts by default — a real
supply-chain-attack mitigation — so `@prisma/client`'s normal auto-`prisma generate` postinstall
hook silently never ran. Every local machine this project had been developed on had, at some
point, run `prisma migrate dev` (which *does* auto-generate), leaving a stale-but-functional
client around indefinitely and masking the gap entirely. Fixed by adding an explicit
`pnpm --filter @santim/web db:generate` step to both the `quality` and `integration` jobs — and
verified, before pushing, via a genuinely clean-clone simulation (`git clone --local
--no-hardlinks`) that ran every CI step in order and confirmed 89 tests passed against a checkout
with no prior local state to hide behind.

### 5.3 `Unable to resolve action 'aquasecurity/trivy-action@0.29.0'`

A missing `v` prefix — the action's real tags are `v0.29.0`, not `0.29.0`. Confirmed via
`gh api repos/aquasecurity/trivy-action/tags` before touching the file, and fixed by pinning to
the current latest (`v0.36.0`) rather than just re-adding the `v` to a version already a year
stale — a vulnerability scanner is one of the few actions where running an old version has a real,
ongoing cost (a stale CVE database), not just a hygiene preference.

### 5.4 `Cannot find matching keyid` — a real npm registry key rotation

Once the previous three fixes let the Docker build actually start, it failed inside the image
build itself: `pnpm install --frozen-lockfile` erroring in ~0.25 seconds — too fast to be a real
dependency-tree fetch, which pointed at Corepack's own lazy download-and-verify of the pnpm binary
(triggered by `corepack enable` plus the first `pnpm` invocation), not at pnpm installing this
project's actual dependencies. Confirmed directly against real data: npm had rotated its registry
signing key (verified via `registry.npmjs.org/-/npm/v1/keys` and `pnpm@10.32.1`'s own
`dist.signatures`), and Corepack versions before `0.31.0` (documented upstream as
`nodejs/corepack#612`) mishandle the rotated key. The base image, `node:22.13-alpine`, bundled a
pre-`0.31.0` Corepack. Fixed by explicitly pinning and installing a current Corepack
(`npm install -g corepack@0.35.0`) before every `corepack enable`, in every Dockerfile stage —
verified by installing that exact Corepack version in isolation and confirming it activates
`pnpm@10.32.1` cleanly against the real, live, currently-rotated registry state, where the old one
failed.

### 5.5 The Trivy scan's real findings — 21 OS CVEs, a stale test key, and 37 dependency CVEs

The image finally built — and the vulnerability scan surfaced genuine findings, triaged
individually rather than suppressed wholesale:

- **21 OS-level CVEs** (stale Alpine OpenSSL/musl/zlib) — fixed by bumping the pinned Node base
  image to the current `22.23.2-alpine`, verified directly against Alpine's own package
  repository (not assumed from the version bump alone) that every flagged package's fixed version
  was actually met.
- **A HIGH secrets-scanner hit** on a real EC private key — the SDK vendor's own published
  testbed-only example, used to pre-sign k6 load-test fixtures, real and intentional but
  indistinguishable from a leaked production secret to a scanner, and with no reason to ship
  inside the image at all. First attempt: delete the file with a `RUN rm` in the runner stage —
  which *did not work*, because Docker layers are additive and the file's bytes were already
  committed to an earlier layer; a later `rm` only hides it from the final merged view. Fixed for
  real by moving the deletion into the `builder` stage, before the runner stage's
  `COPY --from=builder` ever receives it — confirmed the difference matters by watching the scan
  keep finding the "deleted" key after the first attempt, then stop after the second.
- **37 npm dependency CVEs**, triaged individually with `pnpm why -r <pkg>` rather than assumed to
  be one uniform problem: six packages (`tar`, `brace-expansion`, `sigstore`, `glob`,
  `ip-address`, `minimatch`, later joined by `picomatch`) traced entirely to npm's own bundled
  tooling — confirmed absent from this project's own dependency tree, present only because the
  newest npm bundled with any current `node:22-alpine` image still lags the fixed versions, and
  documented in a `.trivyignore` with the exact reasoning per CVE. Three packages (`nanoid`,
  `postcss`, `sharp`) *were* reachable, via `next@15.5.23`'s own dependency tree — fixed for real
  via `package.json`'s `pnpm.overrides`, verified by regenerating the lockfile and confirming
  typecheck, both unit test suites, and an actual `next build` all still passed against the
  overridden versions.

**The throughline across all five:** every fix was verified against the real, live, currently-true
state of something external to this repository — the actual npm registry's key-rotation state,
Alpine's actual current package versions, GitHub's actual tag list for a third-party action — never
assumed correct from documentation or memory. A guess would have been faster to write and slower
to actually resolve, because a guess that happens to be wrong just produces the next failure in
the same CI run.

---

## 6. Supply chain: what's real, and two honest gaps

**SBOM** — real, via `anchore/sbom-action@v0` in `ci.yml`'s `build` job, producing an SPDX-format
software bill of materials uploaded as a build artifact with a 90-day retention.

**Vulnerability scanning** — real and, per §5.5, genuinely exercised: Trivy, gated on
HIGH/CRITICAL severity, `ignore-unfixed: true`, with a precisely-scoped `.trivyignore` rather than
a blanket suppression.

**Image signing** — real, via `sigstore/cosign-installer@v3` and keyless signing in `deploy.yml`:
`cosign sign --yes "<image>@<digest>"`. The comment states why keyless matters specifically:
*"the signature is tied to this workflow's identity, not a private key sitting in repo secrets
that would need rotating and could leak."* Keyless signing uses OIDC (the same federation
mechanism as §7 below) to get a short-lived certificate from Sigstore's Fulcio, tying the
signature to *this specific GitHub Actions run's* identity rather than a long-lived secret this
repo would otherwise have to safeguard and rotate forever.

**Dependency pinning** — real and pervasive by this point in the curriculum: `packageManager` in
`package.json`, `ARG NODE_VERSION`/`ARG COREPACK_VERSION` in the Dockerfile, exact version tags on
every third-party GitHub Action (verified individually against each action's real published tags,
per §5.3's own lesson).

**Two honest gaps, not yet built:**

- **SLSA provenance attestation** — the master plan names this alongside SBOM/scanning/signing as
  a supply-chain concept, but nothing in this repository's workflows produces one. Cosign *signs*
  the image; a SLSA provenance attestation would additionally assert verifiable facts about *how*
  it was built (which workflow, which commit, which builder) in a machine-checkable format a
  consumer could verify before trusting the image. Real, valuable, and genuinely absent here.
- **Dependabot or Renovate** — no `.github/dependabot.yml`, no Renovate config, anywhere in this
  repository. Every dependency pin in this codebase is exact and current as of when it was set,
  and precisely zero of them will update themselves. The five bugs in §5 above are, not
  coincidentally, almost entirely instances of "a pinned thing quietly became stale relative to
  the outside world" — exactly the class of problem automated dependency update tooling exists to
  surface *before* it becomes a CI failure discovered the hard way.

---

## 7. Secrets in CI: OIDC federation over long-lived keys

```yaml
# deploy.yml
permissions:
  contents: read
  packages: write
  id-token: write  # OIDC federation to the registry/cluster — no long-lived cloud keys stored as secrets
```

`id-token: write` grants this specific workflow run permission to request a short-lived OIDC token
from GitHub, which a properly configured cloud provider or registry can exchange for real
credentials scoped to exactly this run — without this repository ever storing a long-lived cloud
access key as a GitHub secret at all. The advantage over a stored secret isn't just convenience:
a long-lived key that leaks (accidentally logged, exfiltrated from a compromised dependency, a
misconfigured `run:` step echoing it) is valid until someone notices and rotates it. A token
obtained via OIDC federation is scoped to a single workflow run and expires with it — there's
nothing long-lived to leak in the first place. This is the same mechanism, and the same reasoning,
behind cosign's keyless signing in §6 — both derive their trust from *this workflow run's own
identity*, asserted fresh by GitHub via OIDC, rather than from a secret that has to be safeguarded
indefinitely.

---

## Labs

### Lab 6.1 — Reproduce bug #4 from scratch, for real

Pull `node:22.13-alpine` specifically (the exact base image this project's Dockerfile was pinned
to before the fix). Inside it, run `corepack enable` with a `package.json` declaring
`"packageManager": "pnpm@10.32.1"`, and attempt `pnpm --version`. Confirm you hit the same
`Cannot find matching keyid` error, for the same real reason (query
`registry.npmjs.org/-/npm/v1/keys` yourself and compare against what the error message reports as
locally trusted). This is the one bug in §5 that depends on genuinely external, time-sensitive
state (a registry key rotation that already happened) — reproducing it for real, rather than
reading about it, is the only way to feel how fast-and-quiet this kind of failure actually is.

### Lab 6.2 — Prove the migration-ordering fix actually blocks a premature rollout

Against a real (even local, `kind`-based) cluster: apply the *old* sequence (no `kubectl wait`
step) with a migration deliberately made slow (add a `pg_sleep(30)` to a throwaway migration).
Confirm the Deployments' rollout can complete before the migration Job does. Then apply the *fixed*
sequence with the same slow migration, and confirm the Deployments' rollout genuinely blocks until
`kubectl wait --for=condition=complete` returns. This is the one fix in this phase that couldn't be
verified end-to-end in the environment this curriculum was written in — this lab is that missing
verification, for you to complete against real infrastructure.

### Lab 6.3 — Add Dependabot, then let it prove §6's point

Add a real `.github/dependabot.yml` covering the pnpm ecosystem, GitHub Actions, and Docker base
images. Let it run for real (or trigger a manual check). When it opens a PR bumping something —
almost certainly a GitHub Action to a newer tag — let `ci.yml` actually run against that PR rather
than merging on faith. This closes the exact gap §6 names: a pin going stale is now something CI
finds *before* it becomes the next version of one of §5's bugs, not after.

### Lab 6.4 — Add SLSA provenance to the build

Using `slsa-framework/slsa-github-generator` (or the equivalent current tooling — check what's
current when you do this, the same way this project's own action versions needed checking against
real tags rather than assumed), generate a real provenance attestation for the image
`build-and-push` already builds and signs. Verify it with `slsa-verifier` against the actual
digest this workflow produces, not a hand-constructed example.

---

## Gate — do not proceed to Phase 7 until you can do this cold

1. **Why does `ci-required` exist as a separate job instead of branch protection listing
   `quality`, `integration`, and `build` directly?** (One stable target to configure once; adding
   a new job later means editing `ci-required`'s own `needs:` list, not every repo's
   branch-protection settings, which nothing enforces gets updated in step.)
2. **This project caches at three different layers. Name a scenario where the GHA Docker layer
   cache is cold but the BuildKit pnpm store mount still saves real time.** (A lockfile change
   invalidates the `deps` layer entirely — no GHA layer cache hit — but the BuildKit-mounted pnpm
   store still has every package's content cached from the last build, so `pnpm install` re-
   resolves without re-downloading from the registry.)
3. **A Job's pod template is immutable once created. Why does that make `kubectl set image` — the
   exact mechanism this pipeline already uses correctly for Deployments — unusable for the
   migration Job, and what did this phase's fix do instead?** (`kubectl set image` mutates an
   *existing* resource's template, which the Kubernetes API rejects for Jobs; the fix deletes any
   prior Job and creates a fresh one with the correct digest baked in from the start, since that's
   the only point in a Job's lifecycle where its image can be set at all.)
4. **Every one of §5's five bugs was fixed by checking real, external, current state before
   writing the fix. Pick one and state exactly what real state was checked, and what would have
   gone wrong trusting memory or documentation instead.** (E.g., bug #3: checking
   `aquasecurity/trivy-action`'s actual published tags via the GitHub API, rather than assuming
   the existing `0.29.0` pin's format was already correct — trusting the existing pin would have
   just re-produced the same failure.)
5. **Name the two supply-chain concepts this project's own workflows do NOT implement, and what
   each would add on top of what cosign's signing already provides.** (SLSA provenance — verifiable
   facts about *how* an image was built, not just that it was signed by this workflow; and
   automated dependency updates via Dependabot/Renovate — catching a stale pin *before* it causes
   a failure, rather than after, which is how nearly every bug in §5 actually got found.)

---

*Next: `07-infrastructure-as-code.md` — Phase 7: the Kustomize base/overlay pattern in
`infra/k8s/`, and everything the staging and production overlays each patch differently, and why.*
