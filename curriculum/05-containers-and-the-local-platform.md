# Phase 5 — Containers & the Local Platform

*Same method as Phases 1–4: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. This phase found one genuine, measured gap in
the codebase while being written — a missing `.dockerignore` — and fixed it as part of writing
this document, the same way earlier phases fixed real citation errors. The before/after
measurement is in §5 below, not hidden.*

---

## Why this phase exists

Phase 4 made the interface fast. This phase makes *running the whole system* — locally, in CI, and
eventually in a cluster — behave identically everywhere, on purpose. `docker-compose.yml`'s own
header states the actual goal, and it's worth reading literally rather than skimming past:

> The point of this file is not "so the app runs". It is so that the app runs THE SAME WAY it runs
> in production: separate web and worker processes, a real Postgres, real healthchecks, real
> dependency ordering. Every difference between your laptop and production is a bug you will find
> at the worst possible moment.

---

## 1. Layer order is the whole game

`infra/docker/Dockerfile`'s own header states this as its single organizing principle:

> LAYER ORDER IS THE WHOLE GAME. Copy the lockfile before the source, because Docker invalidates
> every layer after the first one that changed. Copy source first and every single build
> reinstalls the internet.

Docker builds an image as a stack of cached layers, one per instruction, and a layer is only
rebuilt if *its own inputs* changed — but the moment one layer rebuilds, **every layer after it**
rebuilds too, regardless of whether they'd have produced the same output. The `deps` stage exploits
this directly:

```dockerfile
# Only the files that determine the dependency graph. Nothing else.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/santimpay/package.json ./packages/santimpay/
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile
```

Only the files that determine *what gets installed* are copied before `pnpm install` runs. Edit a
hundred lines of application code — `checkout-service.ts`, a React component, anything under
`src/` — and none of it invalidates this layer, because none of it was part of what got copied
before the install ran. The alternative ordering (`COPY . .` before `pnpm install`) would mean
Docker's cache sees the copied source tree change on *every single commit*, invalidates the layer
containing `COPY . .`, and therefore invalidates `pnpm install` right after it too — reinstalling
every dependency, on every build, forever, regardless of whether a single dependency actually
changed.

**The habit this teaches, generalized beyond Docker:** any time you're structuring a sequence of
cacheable steps — not just Docker layers, CI job steps, build pipelines — order them from
"changes rarely" to "changes constantly," and put the expensive step immediately after the
least-frequently-changing input it depends on.

---

## 2. Multi-stage builds: why `deps`, `builder`, and `runner` are three separate stages

The Dockerfile's own header names what each stage is for and why the split matters:

> `deps` installs node_modules ONCE, cached on lockfile content alone. Edit application code a
> hundred times and this layer is never rebuilt. `builder` compiles. Needs devDependencies; the
> final image must not ship them. `runner` — the shipped image: production deps only, non-root, no
> compilers, no package manager caches, no source maps for the build toolchain.

**The concrete thing this prevents:** TypeScript, `prisma`'s CLI, test runners, and every
`devDependencies` entry are all needed to *build* this app — `tsc`, `prisma generate`, `next
build` all run in the `builder` stage — but none of them belong in the container that actually
serves traffic. Every one of those tools is attack surface (a compiler is a more useful thing for
an attacker inside a compromised container to have than not), and every one adds bytes to an image
that gets pulled onto every node in a cluster, on every deploy. `COPY --from=builder` copies only
the *compiled output* — `node_modules` (production deps, from `deps`), the built `.next` output
and compiled SDK (from `builder`) — never the compiler that produced them.

### 2.1 Non-root, and the specific threat model this addresses

```dockerfile
# Run as a non-root user. A container escape is far less interesting to an
# attacker when the process inside was never root to begin with. Alpine's
# `node` image already ships uid 1000 `node` — use it rather than inventing one.
RUN apk add --no-cache tini && chown -R node:node /app
...
USER node
```

A container is not a security boundary the way a VM is — a container *escape* (a real, if
uncommon, vulnerability class in the container runtime itself) hands an attacker whatever
privileges the process inside had. Running as root inside the container means a successful escape
hands them root on the host. Running as an unprivileged user (Alpine's pre-existing `node`, uid
1000 — reused rather than inventing a new one, since it already exists in the base image and
needs no extra `useradd` step) means the same escape hands them a far less useful foothold. This
doesn't prevent an escape; it changes what an escape is worth.

### 2.2 `tini` — a detail that looks cosmetic and isn't

```dockerfile
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@santim/web", "start"]
```

The comment states the concrete failure mode this prevents:

> `tini` as PID 1. Node is not designed to reap zombies or forward signals as PID 1, so without an
> init your SIGTERM never reaches the app and every deploy ends in a 30-second SIGKILL — which is
> exactly a dropped in-flight payment.

Unix signal handling has a quirk that only bites the process running as PID 1: the kernel does
**not** apply a process's own signal handlers to PID 1 unless that process explicitly opts in —
and most application runtimes, Node included, don't. Without `tini` as PID 1, a `docker stop` (or
a Kubernetes pod termination, which sends the exact same `SIGTERM`) is silently ignored by the
`pnpm`/Node process underneath, the orchestrator waits out its grace period, and then sends
`SIGKILL` — an immediate, no-cleanup termination. For most stateless request handling that's
merely rude. For this app specifically, it's the difference between the worker's own graceful
shutdown loop (`main()`'s `while (inFlight > 0) await sleep(100)` — finish the current settlement
before exiting) actually running, versus a payment mid-settlement being torn down mid-transaction.
`tini`'s entire job is being a real PID 1 that correctly forwards signals to the process it
launches, and reaps zombie processes besides — both things Node was never designed to do for
itself.

---

## 3. Pinning strategy: two different answers for two different questions

`ARG NODE_VERSION=22.23.2-alpine` pins the base image to a specific **tag**, not a content digest.
This is a deliberate tradeoff, not an oversight — and this exact codebase makes the *opposite*
choice one layer up the stack, for a different reason:

```dockerfile
FROM node:${NODE_VERSION}
```
— tag-pinned. A specific, known version, but Docker Hub's official images are periodically
rebuilt *under the same tag* to ship security patches to the underlying Alpine packages (this is
exactly how the OS-level CVEs in an earlier phase's Dockerfile work got fixed — the same tag,
`node:22.23.2-alpine`, gained a patched OpenSSL without this project needing to bump anything). At
the exact moment this document was written, that tag resolved to a real, verifiable digest:
`sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` — but that digest is
expected to change over time as the tag gets rebuilt, and this Dockerfile deliberately floats with
it rather than freezing it.

```yaml
# .github/workflows/deploy.yml
- name: Pin the deployed image to this build's digest
  run: |
    kubectl set image deployment/santim-web \
      web="${{ needs.build-and-push.outputs.image }}@${{ needs.build-and-push.outputs.digest }}" \
      -n santim-commerce
```
— digest-pinned. The *application's own built image*, the one this project's CI produces and
deploys, is pinned by content digest, not by a mutable tag like `latest` or even a specific version
tag. The reasoning is in that workflow's own comment: *"a mutable tag can be repointed
(accidentally or by a compromised registry) after this step runs; a digest is the content itself
and cannot silently change underneath us."*

**The distinction that resolves the apparent contradiction:** a base image (`node:22.23.2-alpine`)
is something you *want* to drift slightly over time, within a version you've already vetted, to
keep receiving security patches without manual intervention — tag-pinning is the right tool. A
*deployed application image* is something you want to be **exactly** reproducible — the same
digest on every node in a rollout, the same digest if you roll back to it next month — where any
drift at all, even a well-intentioned patch, is a change nobody explicitly reviewed. Two different
pinning strategies, two different jobs, both correct for what they're pinning.

---

## 4. Compose for the whole stack — and where this curriculum's own master plan is stale

The master plan's own outline for this phase lists "app, Postgres, Redis, worker, MinIO, mailhog"
as the compose stack. Read the real `docker-compose.yml` and only four of those are actually
there: `postgres`, `migrate` (a one-shot job, not listed in the outline at all), `web`, and
`worker` — plus `prometheus`/`grafana` behind an opt-in `observability` profile. **Redis was
removed from this file during this same curriculum-writing effort**, for a concrete, verifiable
reason worth stating plainly rather than glossing over: it was provisioned, and `REDIS_URL` was
wired into both `web` and `worker`'s environment, but nothing ever consumed it — no
`REDIS_URL` field in `env.ts`'s validated schema (the app's single source of truth for
configuration), no `redis`/`ioredis` dependency anywhere in the monorepo. Infrastructure with a
connection string and no consumer is exactly the kind of half-finished piece this project
otherwise avoids, so it was deleted rather than left as a confusing loose end. MinIO (S3-compatible
object storage) and mailhog (a local SMTP test server) were never implemented at all — this
codebase has no file-upload feature yet (product images are seeded as external URLs, see
`docker-compose.yml`'s own note in the seed data comment referenced across earlier phases) and no
outbound email yet (the worker's `deliver()` function, Phase 1 §4, is a logged stand-in the
comment explicitly invites you to replace).

**This is worth sitting with as its own lesson, one level removed from the codebase:** the master
plan you're reading right now is *also* just documentation, written before every phase's
implementation details were finalized, and it can drift out of sync with reality exactly the way
`docs/01-santimpay-protocol-spec.md` did (Phase 2 §6). Trust the code you can run over the plan
you're reading — including this one.

### 4.1 Healthchecks, restart policies, and dependency ordering, read together

Three separate service definitions, extracted down to just the fields this section is about —
worth reading together even though they're not adjacent in the actual file:

```yaml
# postgres:
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U santim -d santim_commerce"]
  interval: 5s
  timeout: 5s
  retries: 10
  start_period: 10s
```

```yaml
# migrate:
depends_on:
  postgres:
    condition: service_healthy
restart: "no"
```

```yaml
# web:
depends_on:
  postgres:
    condition: service_healthy
  migrate:
    condition: service_completed_successfully
```

Three mechanisms working together, not redundantly: the healthcheck answers "is Postgres actually
ready to accept connections" (`pg_isready`, not a blind `sleep 10` — a container can report
"running" from Docker's point of view long before Postgres inside it has finished initializing).
`depends_on: condition: service_healthy` makes `migrate` wait for that real answer, not just for
the container process to have started. And `migrate`'s own `restart: "no"` is deliberate: a
one-shot migration job that failed should stay failed and visible (`docker compose ps` shows it
exited non-zero) rather than being silently restarted forever by Compose's default policy — the
same reasoning `infra/k8s/base/job-migrate.yaml`'s Kubernetes Job (not a Deployment) encodes for
production, one layer up.

`web`'s `depends_on: migrate: condition: service_completed_successfully` is the detail easiest to
miss and most important to get right: **the app doesn't just wait for the migration container to
exist — it waits for that container to have *exited zero*.** Starting the web app before migrations
apply means it boots against a schema Prisma's generated client doesn't match, which fails in
confusing, timing-dependent ways rather than the one clear, loud way "migration container exited
1" fails.

---

## 5. `.dockerignore` — the gap this phase found, measured, and fixed

This repository had **no `.dockerignore` file at all** until this document was written. The
concrete cost of that gap is directly measurable, not theoretical:

```
$ du -sh node_modules .git apps/web/.next
616M    node_modules
2.4M    .git
133M    apps/web/.next

$ du -sh .
753M    .
```

Every `docker build` in this repository was sending **~753MB** to the Docker daemon as build
context — almost entirely `node_modules` (616MB) and `apps/web/.next` (133MB), **neither of which
the Dockerfile needs from the host at all**: the `deps` stage installs its *own* `node_modules`
fresh inside the image via `pnpm install`, and the `builder` stage generates its *own* `.next`
output fresh via `next build`. The host's copies of both were pure waste on every single build —
transferred to the daemon, then never referenced by a single `COPY` instruction. (This matches,
almost exactly, real build-context sizes — "745.2MB", "752.4MB" — observed directly while
debugging this project's CI pipeline earlier in this same effort; this was a live, reproduced
problem, not a hypothetical one.)

**The fix, applied to this repository as part of writing this phase:**

```
# .dockerignore
node_modules
**/node_modules
.next
**/.next

.git

*.log

.env
.env.*
```

Re-measured with a real `docker build` after adding this file — not an estimate, the actual line
Docker itself prints before the build even starts:

```
$ docker build -f infra/docker/Dockerfile --target deps -t santim-deps .
Sending build context to Docker daemon  1.277MB
```

**753MB down to 1.277MB — better than 500× smaller.** The context Docker actually needs — source files,
configs, lockfiles, Dockerfiles, docs — was never large; almost the entire previous transfer was
pure waste. The concrete benefit isn't just build speed either (though skipping a 753MB transfer
on every single build matters plenty): a `.dockerignore` is also the thing standing between an
accidental `COPY . .` and shipping a local `.env` file — containing real
`SANTIMPAY_PRIVATE_KEY_B64`, `SESSION_SECRET`, database credentials — directly into an image
layer. `.env`/`.env.*` are excluded for exactly that reason: the safety net should exist even
though this particular Dockerfile's `COPY` instructions are already selective enough not to need
it. Defense in depth, the same principle Phase 2's webhook verification applied to payment
security, applied here to build-time secret hygiene.

---

## 6. Volumes, networks, secrets — and why environment variables leak

`docker-compose.yml` uses `${VAR:?message}` throughout — Compose's syntax for "fail immediately,
with this specific message, if the variable isn't set":

```yaml
SANTIMPAY_PRIVATE_KEY_B64: ${SANTIMPAY_PRIVATE_KEY_B64:?base64-encode your PEM key}
SESSION_SECRET: ${SESSION_SECRET:?generate with openssl rand -base64 48}
```

This is a real, working safety net for **local development** — Compose refuses to start the stack
at all rather than silently booting with an empty secret. But it's worth being precise about what
plain environment variables actually protect against, and what they don't: `docker inspect` on a
running container shows every environment variable it was started with, in cleartext, to anyone
with access to the Docker socket. So does `/proc/1/environ` from inside the container, to anyone
who gets a shell in it. An environment variable is *not* protected from anyone who can already
reach the container or its host's Docker daemon — it's protected from someone reading the image
itself (assuming, per §5, that a real secret never got baked into a layer via a careless `COPY`),
and from a casual `docker-compose.yml` file leak (since these reference a variable, not a literal
value — the literal values live in a `.env` file this repo's own `.dockerignore`, per §5, now keeps
out of every build).

`infra/k8s/base/secret.yaml`'s own header is direct about the next level of this problem, one
layer up the stack:

> TEMPLATE ONLY... this file documents the required shape of the Secret... but it must NEVER be
> the source of real secrets in any environment a customer's money touches.
>
> In staging/production, this file is not applied directly. Instead: External Secrets Operator
> syncs from AWS Secrets Manager / GCP Secret Manager / Vault into a Secret with this same name and
> these same keys, or Sealed Secrets encrypts the real values asymmetrically so the ciphertext
> itself is safe to commit.

**The reason a Kubernetes `Secret` isn't itself sufficient**, worth knowing precisely rather than
assuming "Secret" means "encrypted": a `kind: Secret` object's values are base64-**encoded**, not
encrypted — trivially reversible by anyone who can `kubectl get secret -o yaml`, and (depending on
cluster configuration) not necessarily encrypted at rest in `etcd` either. That's exactly why this
codebase's own template steers production toward a real secrets manager or Sealed Secrets rather
than treating a committed (or even cluster-applied) plain `Secret` manifest as the source of
truth — the object type's name promises more than its default behavior actually delivers.

---

## Labs

### Lab 5.1 — The master plan's own break exercise

`docker compose kill` the `postgres` container mid-checkout — specifically, time it to land between
`placeOrder()`'s transaction starting and committing (the same stalling technique as
`chaos-checkout-atomicity.ts`, Phase 2 Lab 2.4, gives you a reliable window rather than racing a
fast transaction). Watch what the customer's browser actually shows. Then bring `postgres` back up
and confirm: no partial order exists, no orphaned reservation exists, and the customer's next
retry succeeds cleanly. This is the *same* proof Phase 2's chaos drill already made for a killed
*application process* — repeat it here for a killed *dependency* instead, and confirm the failure
mode is identical (a clean rejection, not a hang or a partial commit) regardless of which side of
the connection died.

### Lab 5.2 — Prove the `.dockerignore` fix for real

Using `docker build` with `--progress=plain` (or the equivalent for your builder), compare the
reported build-context transfer size before and after §5's `.dockerignore` — check out the commit
before it was added, build, note the size; check out the commit after, build, note the size again.
Confirm the difference matches the `du` measurements in §5, not just in theory but in an actual
build log.

### Lab 5.3 — Add real resource limits

This codebase's `docker-compose.yml` has no `mem_limit`/`cpus` (or Compose's `deploy.resources`
equivalent) anywhere — a real, current gap, not a design decision with reasoning documented
elsewhere the way the Redis removal or the tag-vs-digest pinning split are. Run the stack under a
realistic load (`infra/load-testing/k6/`'s scripts, from a much earlier phase's material — or a
manual burst of concurrent checkouts) while watching `docker stats`. Note actual memory and CPU
usage for `web` and `worker` under load, then set `mem_limit`/`cpus` on each service to a
reasonable multiple of what you observed — tight enough to catch a real leak, loose enough not to
OOM-kill a legitimate traffic spike. This is exactly the kind of number that shouldn't be guessed
without measurement, which is why it was left as a lab rather than filled in with an arbitrary
default while writing this phase.

### Lab 5.4 — Trace a secret from `.env` to a running process, and back out again

Set a fake `SESSION_SECRET` in a local `.env`, bring the stack up, then find that value three
different ways: `docker inspect <web-container> --format '{{.Config.Env}}'`, a shell inside the
container reading `/proc/1/environ`, and — if you deliberately (and only in this throwaway local
experiment) `COPY .env .` into a scratch image — `docker history` or extracting a layer and
`grep`-ing it. Confirm all three actually expose it, then delete the scratch image. This is the
concrete version of §6's claim, not just an assertion to take on faith.

---

## Gate — do not proceed to Phase 6 until you can do this cold

1. **Why does copying `package.json` and the lockfile before the rest of the source, instead of
   after, actually change build time — mechanically, not just "it's faster"?** (Docker invalidates
   a layer and everything after it the moment that layer's own inputs change; source code changes
   far more often than dependencies do, so keeping the install step's inputs isolated to just the
   dependency-defining files means routine code edits never invalidate the expensive install step.)
2. **Name one thing that belongs in the `builder` stage and must never reach the `runner` stage,
   and explain the actual risk of it leaking through, not just "it's bigger."** (The TypeScript
   compiler, Prisma CLI, any devDependency — the risk is attack surface: a tool useful for
   *building* the app is also frequently useful to an attacker who's compromised the *running*
   container, and every unnecessary binary is something to audit and patch that has zero purpose
   in production.)
3. **This project pins its Node base image by tag and its own deployed application image by
   digest. Aren't those contradictory? Resolve it.** (No — a base image benefits from drifting
   within a vetted version to receive security patches automatically; a deployed application image
   needs to be byte-for-byte reproducible on every node and every rollback, where any drift at all
   is unreviewed. Different jobs, different correct answers.)
4. **A `.dockerignore` was missing from this repo. Name two distinct categories of harm that
   caused, not just one.** (Wasted build-context transfer time on every single build — a
   performance cost with a real measured number; and a missing safety net against a careless
   `COPY` instruction ever shipping a local `.env` file's real secrets into an image layer — a
   security cost that never actually happened here, but had nothing structurally preventing it.)
5. **A Kubernetes `Secret` object's values are base64-encoded. Why is that meaningfully different
   from encrypted, and what does this codebase's own `secret.yaml` template say to do about it in
   a real environment?** (Base64 is trivially reversible by anyone who can read the object at all
   — it's an encoding, not a cryptographic protection. Real secrets belong in a proper secrets
   manager synced in via External Secrets Operator, or committed as Sealed Secrets ciphertext —
   never applied directly as plaintext-equivalent `stringData` outside a scratch/dev cluster.)

---

*Next: `06-cicd-and-software-supply-chain.md` — Phase 6: everything `ci.yml` and `deploy.yml`
actually do, told through the five real, sequential bugs it took to get this project's own
pipeline to a single green run for the first time.*
