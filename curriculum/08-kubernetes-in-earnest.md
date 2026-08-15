# Phase 8 — Kubernetes in Earnest

*Same method as Phases 1–6: every claim is illustrated with a real file from `santim-commerce`.
Open the referenced file alongside this document. `infra/k8s/base/pdb.yaml`'s own comment
references this exact phase's "BREAK" exercise by name — this codebase's manifests were written
with this curriculum already in mind, which is as good a sign as any that the two were meant to be
read together.*

---

## Why this phase exists

Phase 7 found that nothing in this repository describes how a Kubernetes cluster gets created.
This phase is about everything that happens *inside* one, once it exists — and unlike Phase 7,
there's no shortage of real material here: `infra/k8s/base/` is a complete, carefully-reasoned set
of manifests, validated with `kubeconform -strict` (Phase 5's own verification discipline, applied
here), even though — worth restating plainly — no live cluster has ever actually run any of it in
this environment.

---

## 1. The reconciliation loop — the one idea underneath everything Kubernetes does, and the one
this project already understood before writing a line of YAML

Kubernetes' actual mechanism, underneath every controller, is embarrassingly simple stated
directly: **watch the difference between desired state and observed state, and keep taking small
actions to close the gap, forever, without ever assuming the gap is closed for good.** A
Deployment controller doesn't create N pods once — it *continuously* compares "N pods should
exist" against "how many actually do," and reconciles the difference on every loop, whether a pod
died from a crash, a node failure, or a human `kubectl delete`.

**This project already built the identical pattern, outside Kubernetes, before this phase's own
subject matter existed in the codebase at all.** Phase 1 §8's webhook/poller/reconciler triple is
the *same idea*, applied to payment state instead of pod count: `settlePayment()` doesn't trust
that a webhook "closed the gap" once — the poller keeps checking, the reconciler sweeps everything
still open, and every trigger converges on the same authoritative check (the Transaction Status
API) rather than assuming its own prior action succeeded. `worker/index.ts`'s own module comment,
already quoted once in this curriculum, is worth reading again with this phase's framing in mind:
*"webhook ──┐ / poller ──┼──▶ settlePayment(merchantTxnId) ──▶ status API ──▶ txn commit /
reconciler─┘"* — three independent triggers, one convergence loop, exactly Kubernetes' own
architecture in miniature. **Recognizing this pattern once, here, means recognizing it in every
controller you'll ever read the source of — a Deployment controller, an HPA controller, a
cert-manager certificate renewal loop — because it's the same idea wearing a different domain's
clothes every time.**

---

## 2. Workloads — and a real mismatch between this curriculum's own master plan and the code

`infra/k8s/base/` uses exactly two workload kinds, deliberately: **Deployment** (`santim-web`,
`santim-worker` — long-running, N replicas, reconciled continuously) and **Job**
(`santim-db-migrate` — run to completion once, covered in depth in Phase 6 §4). There is no
`StatefulSet` (Phase 7 §0 already found why: no Postgres runs inside this cluster at all) and —
worth being precise about, since this curriculum's own master plan states otherwise — **no
`CronJob`.**

The master plan's Phase 8 outline literally parenthesizes *"your reconciler is a CronJob."* Grep
`infra/k8s/` for `kind: CronJob` and there's nothing there. The real reconciler is
`worker/index.ts`'s in-process loop, `RECONCILE_EVERY_MS = 15 * 60_000`, running inside the same
long-lived `santim-worker` Deployment that also runs the poller and the outbox publisher —
**not** a separate Kubernetes-scheduled batch job.

**Checking how far this actually spreads turned up more than Phase 2 §6 alone found.** That phase
quoted the protocol spec's *"Nightly cron over all non-terminal intents older than 1h"* as the one
stale claim. Searching this codebase's own source for the same word: `nightly` appears **five
times, across four files** — the protocol spec twice (the table Phase 2 quoted, plus an unrelated
checklist item), `docs/runbooks/01-stuck-payment.md` once, and — the one worth pausing on —
**`state-machine.ts` itself, twice**, in comments sitting directly beside code this curriculum has
already quoted verbatim: the `EXPIRED: ["COMPLETED", "FAILED"]` transition (Phase 1 §5's own
worked example) is explained as *"what lets the nightly reconciler heal an order,"* and
`POLL_SCHEDULE_SECONDS`'s own doc comment (Phase 2 §6's worked example) calls the same thing *"a
human or the nightly reconciler."* Meanwhile `deployment-worker.yaml`'s header, independently,
calls it an *"hourly reconciler."* Every one of these is wrong the same way — the real interval is
15 minutes (`RECONCILE_EVERY_MS`) — and none of the wrong descriptions even agree with each other.
That's a more useful fact than a single stale comment would be: it means whichever number was true
when these comments were written changed once, later, in one place (the constant itself), and nobody
went back to check every place that had described it in prose — including, notably, comments sitting
in the exact same file as the code this curriculum was already citing as a real, trustworthy
worked example in two earlier phases. Trustworthy code and a trustworthy comment two lines above it
are not the same claim.

This is worth reasoning through rather than
just correcting, because the real design is arguably the better call for this specific workload,
not a shortcut:

- A `CronJob` spins up a fresh pod on each scheduled run, does its work, and exits — appropriate
  for genuinely independent, stateless-between-runs batch work.
- This project's reconciler needs to run *frequently* (every 15 minutes) and shares significant
  in-process state and infrastructure with the poller and outbox publisher it runs alongside —
  the same Prisma connection pool, the same metrics registry, the same graceful-shutdown handling
  (`main()`'s `while (inFlight > 0)` loop, Phase 5 §2.2's `tini` discussion). Splitting it into a
  separate `CronJob` would mean either duplicating that infrastructure in a second workload, or
  building cross-process coordination that doesn't need to exist — the reconciler is a **loop
  inside a process that's already running anyway** for other reasons, not a task that ever needed
  its own scheduled pod.

**The lesson, stated generally:** a master plan is a plan, written before the implementation
details were final — this is the same category of finding as Phase 5 §4's stale compose-stack
outline and Phase 6 §4's stale README claim, and it's worth treating your own planning documents
with the same skepticism you'd apply to a vendor's. The code, watched running, is what's actually
true.

---

## 3. Networking: Service types, and NetworkPolicy as an enforced fact instead of a diagram

Two `Service` objects, both `ClusterIP` (internal-only — nothing here is a `LoadBalancer` or
`NodePort`; that job belongs to the Ingress, Phase 5's TLS-termination discussion), for two
different reasons:

`santim-web` — receives real customer traffic, routed in via the Ingress:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: santim-web
  ...
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: santim-web
  ports:
    - name: http
      port: 80
      targetPort: http
```

`santim-worker-metrics` — its own real comment states why it exists at all:

```yaml
# Cluster-internal only — never referenced by the Ingress. Exists purely so
# Prometheus (or a ServiceMonitor, if using the Prometheus Operator) has a
# stable DNS name to scrape the worker's metrics port from.
apiVersion: v1
kind: Service
metadata:
  name: santim-worker-metrics
  ...
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: santim-worker
  ports:
    - name: metrics
      port: 9091
      targetPort: metrics
```

The second Service is worth sitting with: it exists for a consumer that is **infrastructure, not a
customer** — Prometheus needs a stable name to scrape, and a `Service` is the mechanism Kubernetes
gives you for "a stable address in front of a set of pods," regardless of whether those pods ever
serve a browser request. Not every `Service` in a real cluster is there to route customer traffic.

### 3.1 Default-deny, then named exceptions

`networkpolicy.yaml`'s own header states the actual security model:

> Default-deny, then explicit allows. The absence of a NetworkPolicy in a namespace means "every
> pod can talk to every pod" — the flattest, least defensible network in the cluster. This makes
> the santim-commerce namespace's actual data flow an enforced fact, not a diagram nobody checks.

Three policies: a blanket `default-deny-all` (`podSelector: {}`, denying all ingress and egress by
default), then `allow-web` and `allow-worker`, each naming *exactly* what that specific workload is
permitted to reach. Reading `allow-web`'s egress rules **is** an accurate architecture diagram of
this app's real network dependencies, enforced rather than aspirational: DNS (port 53, both
protocols — nothing resolves a hostname without this), Postgres in the `data` namespace (port
5432), and the public internet over HTTPS only (port 443 — SantimPay's API). `allow-worker`'s rules
are narrower still: no ingress from anywhere except Prometheus scraping its metrics port, because
— as the comment states — *"It is never a traffic target."* A worker pod compromised by a
dependency vulnerability, under this policy, cannot reach anything this project's own threat model
didn't already expect it to reach — the NetworkPolicy doesn't prevent the compromise, but it
sharply bounds what a compromise is worth.

**One detail worth noticing precisely:** `allow-web`'s ingress rules permit Prometheus to reach
port 3000 — the *same* port serving real customer traffic, not a separate metrics port like the
worker has. The comment addresses this directly: *"Prometheus scrapes `/api/metrics` on the same
port — see that route's own bearer-token gate for why this is still safe to allow at the network
layer."* The NetworkPolicy's job is bounding *who can reach this port at all*; it's not the layer
responsible for what happens once a permitted caller connects — that's the application's own
metrics endpoint checking a bearer token, a second, independent layer of the same defense.

---

## 4. Config: what's a ConfigMap, what's a Secret, and why the line is drawn where it is

`configmap.yaml`'s own header states the rule this project draws the line by:

> Non-secret configuration only... Everything here is safe to read in `kubectl describe configmap`
> by anyone with namespace access.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: santim-web-config
  namespace: santim-commerce
data:
  NODE_ENV: "production"
  LOG_LEVEL: "info"
  SANTIMPAY_ENVIRONMENT: "production"
  SANTIMPAY_TIMEOUT_MS: "15000"
  WEBHOOK_MAX_AGE_SECONDS: "300"
  RESERVATION_TTL_MINUTES: "20"
  WORKER_METRICS_PORT: "9091"
```

Every one of these values is operationally meaningful and worth version-controlling — but none of
them, read in isolation by an attacker with namespace access, hands over anything they could act
on. Contrast with `secret.yaml` (Phase 5 §6, Phase 7 §0's finding about its `DATABASE_URL`
placeholder): `SANTIMPAY_PRIVATE_KEY_B64`, `SESSION_SECRET`, database credentials — values whose
disclosure alone is the entire incident. **The test worth applying to any config value:** "if this
specific value leaked to someone with no other access, is that itself the incident, or just
information?" A `ConfigMap`/`Secret` split enforced by that test, rather than by vague instinct, is
the difference between a `Secret` object that's actually meaningful and one that's just a
`ConfigMap` with extra ceremony.

---

## 5. Storage — the question Phase 7 already found unanswered

There is no `PersistentVolumeClaim`, no `StorageClass`, anywhere in `infra/k8s/`. This isn't a new
finding — it's the same evidence Phase 7 §0 already used to establish that Postgres is assumed to
be provisioned externally, restated here because it's *also* the direct, concrete answer to this
phase's own "should the DB live in Kubernetes" question: **this project's actual answer, currently,
is that it doesn't, and there's no `StatefulSet` here for it to live in even if that changed.**
Running Postgres inside Kubernetes via a `StatefulSet` plus a `StorageClass`-backed `PVC` is a real,
legitimate option (Phase 7 §2's managed-vs-self-hosted framing applies almost unchanged — "inside
k8s" is simply the most self-hosted end of that same spectrum), but it's not what this project's
current manifests reflect, and nothing here should be read as implying otherwise.

---

## 6. Scheduling: requests, limits, and the QoS class this project's pods actually get

```yaml
# deployment-web.yaml
resources:
  requests:
    cpu: 250m
    memory: 384Mi
  limits:
    # No CPU limit: CPU-throttling a request-serving process under its own
    # limit causes exactly the p99 latency spikes an SLO dashboard will
    # page someone about. Memory DOES get a limit — a leak should
    # crash-and-restart the one pod, not starve the node.
    memory: 512Mi
```

**Compute the resulting QoS class rather than taking it on faith**, because it's determined by a
precise rule, not a label anyone chose directly: `Guaranteed` requires *every* resource (CPU and
memory both) to have requests exactly equal to limits; `BestEffort` requires no requests or limits
at all; anything else — including this pod's exact configuration, a CPU request with no CPU limit,
and a memory request that's lower than its memory limit — is `Burstable`. That's not an oversight;
it's the direct, mechanical consequence of the reasoning in the comment above: deliberately
*not* setting a CPU limit (to avoid throttling-induced latency spikes) makes `Guaranteed` QoS
structurally impossible for this pod, and that's an accepted, reasoned tradeoff, not a gap. Under
real memory pressure, `Burstable` pods are evicted before `Guaranteed` ones and after `BestEffort`
ones — worth knowing precisely if a future capacity incident ever needs explaining, rather than
discovering the eviction ordering for the first time during the incident itself.

**What's real here, and what isn't, worth being precise about both:** requests/limits (above) and
`PodDisruptionBudget` (§7 below) are both real, reasoned, present in this codebase. Affinity rules,
taints/tolerations, and topology spread constraints are not present anywhere in `infra/k8s/` —
a genuine, current gap, not a decision documented anywhere the way the CPU-limit omission is. With
`replicas: 3` (web) and no topology spread constraint, nothing here currently guarantees those
three pods land on different nodes at all — a single node failure could, in the worst case, take
out more than one replica simultaneously, undermining exactly the availability the `PodDisruptionBudget`
below is designed to protect during a *voluntary* disruption. Voluntary and involuntary disruption
are different problems, and this project has only solved one of them so far.

---

## 7. The Break exercise — and the manifest already written with it in mind

`infra/k8s/base/pdb.yaml`'s own comment is the rare case in this curriculum of a piece of code
directly naming the exact exercise this document is about to assign:

> Caps how many web pods a voluntary disruption (node drain, cluster upgrade, `kubectl cordon`) may
> take down at once. Without this, an operator draining a node during a deploy could take out
> enough replicas simultaneously to drop checkout traffic — exactly the scenario the curriculum's
> Phase 8 "BREAK" step calls out explicitly: drain a node during checkout, expect zero failed
> payments.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: santim-web
  namespace: santim-commerce
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: santim-web
```

`minAvailable: 2` against `replicas: 3` means Kubernetes will refuse to voluntarily evict more than
one `santim-web` pod at a time — a `kubectl drain` on a node hosting two of the three replicas
blocks on the second eviction until a replacement pod is ready elsewhere, rather than proceeding
and dropping the service to one pod (or zero) all at once. **Why "zero failed payments" is a
reasonable bar to actually hold this to, not just an aspiration:** nothing about a node drain is
supposed to be visible to a customer mid-checkout in the first place, given everything Phases 1–2
already built — `startPayment()`'s commit-before-call ordering means an in-flight request survives
a pod restart at the database level regardless of what happens to that specific pod, and the
readiness probe (§8 below) means a pod about to be drained gets pulled from the Service *before*
new requests land on it, not concurrently with them. The PDB's specific job is narrower than
"prevent any customer impact" — it's "don't let a routine maintenance operation remove more
capacity at once than the remaining pods can absorb," which is exactly the gap between "should be
fine" and "verified fine" this document's own labs ask you to close.

---

## 8. Probes done right — grounded in the actual endpoints, not just the YAML

`deployment-web.yaml` configures all three probe types, and `api/health/route.ts`'s own module
comment states the distinction this phase's outline calls "the misconfiguration that causes real
outages" directly:

> LIVENESS vs READINESS — the distinction that causes real outages when it is collapsed into one
> endpoint:
>
> `/api/health` LIVENESS. "Is this process wedged?" It must NOT touch the database. If it did, a
> brief Postgres blip would fail every pod's liveness probe, Kubernetes would restart the entire
> fleet at once, and a 30-second database hiccup becomes a full outage with cold caches.
>
> `/api/ready` READINESS. "Should this pod receive traffic right now?" This one DOES check
> dependencies. A failing readiness probe removes the pod from the load balancer without killing
> it — so it can recover and rejoin.
>
> Rule of thumb: liveness failure ⇒ restart me. Readiness failure ⇒ stop sending me traffic. Never
> let a dependency decide that you should be killed.

**The failure mode this prevents, made concrete:** if `/api/health` (liveness) checked the
database, a single brief Postgres network blip — the kind Phase 1 §1's "the network is reliable"
fallacy already told you to expect — would fail *every* pod's liveness probe at once (they all
share the same broken dependency), and Kubernetes would restart the *entire fleet simultaneously*,
turning a 30-second database hiccup into a full outage with every pod cold-starting at once. Using
a *separate* endpoint for "can I serve traffic" means the same Postgres blip instead removes pods
from the load balancer one probe-interval at a time, without killing any of them — they simply
rejoin the moment `/api/ready` passes again.

`api/ready/route.ts`'s own implementation has a subtlety worth its own callout:

```ts
// A trivial query, with its own deadline. A readiness probe that can hang
// is worse than no probe at all — the kubelet's timeout fires, but you have
// still tied up a connection from a pool that is already struggling.
await Promise.race([
  prisma.$queryRaw`SELECT 1`,
  new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
]);
```

A readiness check against a *struggling* (not fully down) database is exactly the case where a
naive, undeadlined query makes things worse — every probe interval ties up one more connection
from an already-strained pool, on top of the real traffic already competing for it. The explicit
2-second race is what turns "readiness probe" into a bounded-cost operation regardless of how
unwell the dependency actually is.

**Startup probe, the third and easiest to forget:**

```yaml
startupProbe:
  httpGet:
    path: /api/health
    port: http
  periodSeconds: 5
  failureThreshold: 12 # up to 60s to become healthy before liveness takes over
```

Next.js compiles a route on its first real request after a cold start (in this deployment mode) —
slower than every subsequent request to the same route. Without a startup probe, that one slow
first request risks tripping the liveness probe's own, shorter timeout *during normal pod startup*
— not because anything is actually wrong, but because startup and steady-state have different
latency profiles and one probe config was being asked to correctly judge both. The startup probe
gives a pod up to 60 seconds (12 attempts × 5s) to become healthy before liveness takes over
judging it at all — the two probes never run against the same pod simultaneously.

---

## 9. Autoscaling: what's real, what's a reasoned "not yet," and one genuine gap

```yaml
# hpa-web.yaml
# Only the web tier autoscales — traffic-driven. The worker's workload is a
# trickle of unresolved payments, not proportional to request volume; see
# deployment-worker.yaml's comment on why it stays at a fixed replica count.
```

The web tier's HPA (3–12 replicas, CPU-utilization-targeted at 65%, with an asymmetric
`behavior:` — a 300-second stabilization window scaling *down* against a 0-second window scaling
*up*, specifically because payment-page redirects arrive in bursts and shouldn't cause replicas to
thrash within the same minute) is real and reasoned. The worker's *absence* of an HPA is equally
reasoned, not an oversight — `deployment-worker.yaml`'s own comment (already partially quoted
earlier in this curriculum) explains precisely why scaling it wouldn't help: N replicas would mean
N pollers racing to claim the same due-for-poll rows, doing up to N× the SantimPay API calls for
**zero additional throughput**, since the actual constraint is a fixed trickle of unresolved
payments, not something that scales with request volume the way web traffic does.

**This is exactly the scenario the master plan's own outline names — "KEDA (queue-depth scaling
for your payment worker)" — and it's worth being precise about why KEDA specifically wouldn't
apply cleanly here even if autoscaling the worker ever did make sense:** KEDA scales on an external
metric like queue depth — messages waiting in SQS, Kafka lag, a Redis list length. This worker has
no queue at all; it polls Postgres directly for `PaymentIntent` rows past their `nextPollAt`
(Phase 2 §6). A KEDA scaler would need a *real* queue-depth-shaped metric to trigger on, which this
architecture doesn't produce — and even if one were added, `deployment-worker.yaml`'s own
reasoning about N pollers racing the same rows would still apply just as directly. Scaling the
worker, if it's ever genuinely needed, likely means **partitioning** the poll query (each replica
claims a disjoint slice of due rows) before it means reaching for KEDA at all — a real design
question, not a small config change.

**VPA (Vertical Pod Autoscaler) and Cluster Autoscaler** are both absent too — the former would
recommend or automatically adjust the requests/limits §6 discusses based on observed usage (a real,
useful complement to right-sizing rather than a replacement for HPA), the latter operates one layer
below Kubernetes entirely, adding and removing *nodes* as pod scheduling demand changes — squarely
Phase 7's territory (infrastructure provisioning), and absent for the identical reason nothing else
in that layer exists yet.

---

## 10. Kustomize, not Helm; CI-driven deploys, not GitOps — two more considered "not yet"s

This project uses pure Kustomize (Phase 7 §3's real comparison to Terraform workspaces) with no
Helm chart anywhere — a legitimate architectural choice for a single application with a small,
well-understood set of environment differences, the same category of decision as Phase 7 §4's "no
Ansible" call: Helm's templating language earns its complexity once you're distributing a chart
across many consumers with genuinely different configuration needs you don't control; a two-overlay
(staging/production), one-application deployment has less to gain from it than from Kustomize's
simpler patch-based model.

**GitOps (Argo CD, Flux) and progressive delivery (Argo Rollouts) are both absent, and this one is
worth naming as a real, current gap rather than a considered "not yet"** — `deploy.yml`'s own
design (Phase 6) is push-based: CI directly runs `kubectl apply` against the cluster on a tag push,
rather than committing a manifest change and having a GitOps controller inside the cluster notice
and reconcile it. Push-based CI deploys are simpler to reason about linearly (the deploy *is* the
CI run, start to finish, visible in one place) at the cost of the cluster's actual state being only
as trustworthy as whatever CI last successfully pushed — a GitOps controller continuously
reconciling against the committed manifests would catch and correct *drift* (§1's own core idea,
applied to deployment state itself) the way `kubectl apply`, run once per deploy and never again
until the next one, structurally cannot. Argo Rollouts specifically would unlock canary and
blue/green strategies (Phase 6 §3) without hand-building the traffic-shifting logic — currently
moot, since Phase 6 §3 already reasoned through why this project doesn't need those strategies yet
either.

---

## 11. Service mesh: what it buys, and why saying no is still the right call here

A service mesh (Istio, Linkerd) adds a sidecar proxy to every pod, giving you mutual TLS between
services without each service implementing it, fine-grained traffic splitting beyond what a plain
Service/Ingress offers, and rich per-request observability (latency histograms, retry visibility)
at the network layer instead of instrumented by hand in each service. **None of that is present
here, and — following the same pattern as Phase 1 §7.4's circuit breaker — that's the right call
at this project's current scale**, not a gap to close reflexively: this architecture has exactly
two internal workloads (`web`, `worker`) talking to Postgres and one external API, a topology
`NetworkPolicy` alone already expresses completely (§3.1). A mesh earns its very real operational
cost (another control plane, another thing to upgrade, real added latency per hop) once a system
has enough internal services that manually reasoning about their interactions stops scaling —
which two workloads, demonstrably, doesn't require yet.

---

## Labs

### Lab 8.1 — The Break exercise itself, run for real

Against a real cluster (even local `kind`), place a continuous stream of test checkouts (a k6
script from earlier phases' load-testing suite, or a simple loop) while draining a node hosting at
least one `santim-web` replica: `kubectl cordon <node>` then `kubectl drain <node>
--ignore-daemonsets`. Watch the PDB (`minAvailable: 2`) actually block eviction of a second replica
on the same node until a replacement is ready elsewhere. Confirm, from the checkout stream's own
results: zero failed payments. Then remove the PDB entirely and repeat the exact same drain —
confirm you *can* now reproduce a real, visible checkout failure, so the difference the PDB makes
isn't theoretical.

### Lab 8.2 — Reproduce the liveness-collapse outage on purpose

Temporarily point `/api/health` at the same database check `/api/ready` uses (collapsing the two
probes into one, the exact mistake §8 warns against). Kill the Postgres connection the pods depend
on for a few seconds. Watch what happens to `kubectl get pods` — confirm you get a fleet-wide
restart of every `santim-web` pod simultaneously, not a graceful readiness-driven removal. Revert,
repeat with the real, separate probes, and confirm the pods instead drop out of and rejoin the
`Service` without a single restart.

### Lab 8.3 — Compute, then verify, the QoS class

Before looking it up, work out from `deployment-web.yaml`'s actual `requests`/`limits` (§6) which
QoS class `santim-web` pods should receive. Then run `kubectl describe pod <a-santim-web-pod>`
against a real cluster and confirm `QoS Class:` matches your prediction. Change the manifest to add
an explicit CPU limit equal to the CPU request, redeploy, and confirm the QoS class changes to
`Guaranteed` — then discuss, in your own words, why the original comment argues *against* making
that change permanently for this specific workload.

### Lab 8.4 — Close the topology-spread gap §6 found

Add a `topologySpreadConstraint` (or pod anti-affinity, and compare the two approaches) to
`deployment-web.yaml` so its three replicas are spread across distinct nodes rather than
potentially co-located. Verify with `kubectl get pods -o wide` that they land on different nodes.
Re-run Lab 8.1's drain exercise against a *single* node hosting what would previously have been
two of the three replicas, and confirm the blast radius of one node failure is now provably smaller
than before this constraint existed.

---

## Gate — do not proceed to Phase 9 until you can do this cold

1. **State, in one sentence, the idea this project's own webhook/poller/reconciler pattern and
   every Kubernetes controller both implement.** (Continuously compare desired state against
   observed state and take small corrective actions to close the gap, never assuming a single past
   action closed it for good.)
2. **This curriculum's own master plan says the reconciler is a CronJob. It isn't. Explain why the
   real implementation is arguably the better design for this specific workload, not just
   "different."** (It shares a live process, connection pool, and graceful-shutdown handling with
   the poller and outbox publisher it runs alongside every 15 minutes — splitting it into a
   separately-scheduled CronJob would mean duplicating that shared infrastructure or building
   cross-process coordination that doesn't need to exist for work this frequent and this
   lightweight.)
3. **Why would putting a database check in the liveness probe instead of the readiness probe turn
   a brief Postgres blip into a full outage?** (Every pod shares the same broken dependency, so
   every pod's liveness probe fails at the same moment, and Kubernetes restarts the entire fleet
   simultaneously — a readiness failure instead just removes pods from the load balancer, one at a
   time, without killing any of them, so they can simply rejoin once the dependency recovers.)
4. **A pod has a CPU request with no CPU limit, and a memory request lower than its memory limit.
   Name its QoS class and justify it from the actual rule, not from memory.** (`Burstable` —
   `Guaranteed` requires every resource's request to equal its limit, which isn't true here for
   either resource; `BestEffort` requires no requests or limits at all, which also isn't true —
   anything that's neither of those two exact conditions is `Burstable` by elimination.)
5. **Name the one real, current gap in this phase that isn't a reasoned "not yet" the way the
   service mesh or Helm are — something that's simply missing.** (No topology spread constraints
   or affinity rules anywhere in `infra/k8s/` — with three `santim-web` replicas and nothing
   preventing them from landing on the same node, a single node failure could take out more than
   one replica at once, which is a different failure mode than the *voluntary* disruption the PDB
   already protects against.)

---

*Next: `09-observability-and-sre.md` — Phase 9: the real Prometheus/Grafana stack, the metrics this
codebase actually emits, and what an SLO for a payment system should — and currently doesn't —
look like.*
