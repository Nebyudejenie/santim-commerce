# Phase 7 — Infrastructure as Code

*Same method as Phases 1–6 in spirit, but not in what's available: every previous phase taught
through this codebase's own real, running code. This one can't, for a reason worth stating before
anything else — read §0 first.*

---

## 0. What this phase found, and why it changes how it has to be written

There is no Terraform, no Ansible, and no `infra/terraform/` (or equivalent) directory anywhere in
this repository. `infra/k8s/`'s manifests are hand-maintained YAML, applied directly via
`kubectl apply -k`, not generated or managed by any infrastructure-as-code tool. That alone would
be a normal, bounded gap — a missing layer, the way Phase 6 found a missing `.dockerignore`. What
makes it worth pausing on specifically is what it implies underneath: **nothing in this repository
describes how the Kubernetes cluster itself, the network it runs in, or the Postgres instance every
environment connects to actually get created.**

The evidence is concrete, not inferred: `infra/k8s/base/` has no `StatefulSet` and no
`PersistentVolumeClaim` for Postgres anywhere in it — grep the whole directory and there's nothing
there. `infra/k8s/base/secret.yaml`'s `DATABASE_URL` template is
`postgresql://CHANGE_ME:CHANGE_ME@postgres-host:5432/santim_commerce?schema=public&sslmode=require`
— a bare hostname, `sslmode=require` hinting at a managed service without ever saying so, no
comment addressing where `postgres-host` actually comes from or who's responsible for it existing.
Every other infrastructure decision in this codebase — down to which Corepack version to trust —
has been made explicitly and documented with real reasoning. This one was never made at all.

**What this means for how this phase is written:** every previous phase quoted this codebase's own
comments and code because they existed and were worth trusting. This phase can't do that for its
central subject. What it can do honestly: teach the real concepts properly, be exact about what
*is* real here (Kustomize's overlay pattern, which solves a version of the same DRY-across-
environments problem Terraform workspaces solve, one layer up the stack), and be precise that
closing this gap is genuinely unstarted work — not a stylistic choice, not "out of scope for a demo
project," a real missing piece directly relevant to the "how ready is this for staging" question
this whole curriculum exists alongside.

---

## 1. Terraform concepts, taught straight, without a codebase to lean on

**State** is Terraform's record of what it believes exists, separate from your `.tf` files (which
describe what *should* exist) and separate from the real cloud provider (which has what actually
exists). All three can disagree — that's called **drift**, and it's the normal condition of any
infrastructure a human can also change by hand, not an edge case. State needs to live somewhere
shared and lockable (a remote backend — S3 with DynamoDB locking, Terraform Cloud, GCS with native
locking) the moment more than one person or one CI pipeline might run `terraform apply` at
overlapping times; two applies racing against the same *local* state file is exactly the
check-then-write race from Phase 3 §2.1, wearing infrastructure's clothes instead of a database
row's.

**`plan` as a review artifact** is the single most valuable habit Terraform enables and the one
most commonly skipped under time pressure: `terraform plan` computes and shows the *diff* between
current state and desired state — additions, changes, and (the ones worth reading twice)
destructions — before anything actually happens. Treating a `plan` output as something a second
person reviews, the same way a code diff gets reviewed before merge, catches "this change deletes
the production database's replica" before it happens instead of during the incident retro
afterward. A `terraform apply` run by one person with nobody having seen the plan first is a code
change merged with no review, applied directly to infrastructure instead of to a repository.

**Modules** are how you avoid describing "a VPC with these subnets" or "a Postgres instance with
this configuration" from scratch in every environment. A module takes inputs (instance size,
environment name, CIDR range) and produces the same shape of infrastructure every time it's
called — the infrastructure equivalent of `calculateTax()` from Phase 3 §5.1: one place that knows
*how*, every caller only supplies *what's different this time*.

**Workspaces** let the same module definitions produce genuinely separate, isolated sets of
resources per environment (staging, production) from one codebase, each with its own state. The
alternative — copy-pasting an entire environment's `.tf` files and hand-editing the copy for
production — is the exact anti-pattern DRY module design exists to prevent, and it's precisely the
kind of drift-inviting duplication this project's own Kustomize overlays (§3 below) were built to
avoid at the Kubernetes-manifest layer.

---

## 2. Networking, and managed vs. self-hosted Postgres — the decision this project never made

A real deployment needs, at minimum: a **VPC** (an isolated network boundary), **subnets** (usually
split public — for anything internet-facing, like a load balancer — and private — for everything
that shouldn't be directly reachable, like a database), **security groups** (stateful firewall
rules controlling what can reach what), a **load balancer** with **TLS termination** (so the
Kubernetes Ingress this project's `infra/k8s/base/ingress.yaml` already defines has something in
front of it actually holding a certificate and routing real internet traffic in), and **DNS**
pointing a real domain at that load balancer. None of this is Kubernetes-layer configuration —
it's the layer *underneath* what `infra/k8s/` assumes already exists, and it's exactly the layer
this repository has nothing describing at all.

**The managed-vs-self-hosted Postgres decision, made honest:** running Postgres yourself inside
Kubernetes (a `StatefulSet` with persistent volumes, your own backup cron, your own failover
tooling) costs less in direct cloud spend and gives full control — at the cost of your team being
responsible for every one of those things actually working, correctly, at 3am, including exactly
the kind of disaster-recovery competence `docs/runbooks/05-backup-restore-drill.md` (an earlier
part of this project) already demonstrates real practice with. A managed service (RDS, Cloud SQL,
a comparable offering) costs more per month and trades away some control (you can't always tune
every Postgres setting; failover behavior is the vendor's implementation, not yours to inspect) for
someone else being paged first when a disk fills up. **Neither answer is universally correct — but
this project has an actual answer sitting unstated**, since `docker-compose.yml`'s local dev
Postgres (`postgres:17-alpine`, a plain container, no managed anything — correct for local dev,
where the whole point is running the same shape of stack cheaply) tells you nothing about staging
or production's real answer, and `sslmode=require` in the k8s secret template is the only hint
anywhere in this codebase that "managed service" was probably the intent, never confirmed or acted
on.

---

## 3. The one real, valid comparison this repository actually supports

Terraform workspaces solve environment differentiation at the infrastructure-provisioning layer;
this project's real, existing Kustomize overlays solve the *same category of problem* one layer up
— Kubernetes manifests, not cloud resources — and comparing the two directly is honest, useful
ground, unlike inventing Terraform code that was never written:

```yaml
# infra/k8s/overlays/production/kustomization.yaml — excerpted; the worker
# Deployment gets an identical patch, elided here, and the file also carries
# an `images:` block deploy.yml overrides post-apply (Phase 6 §4.1)
resources:
  - ../../base
patches:
  - target:
      kind: Deployment
      name: santim-web
    patch: |
      - op: add
        path: /spec/template/spec/containers/0/env
        value:
          - { name: DEPLOY_ENV, value: production }
          - { name: SANTIMPAY_ENVIRONMENT, value: production }
  # ... identical patch for santim-worker, and an images: block ...
replicas:
  - name: santim-web
    count: 3
```

Both Kustomize overlays and Terraform workspaces exist to answer the identical question — "how do
staging and production differ, expressed as a small, reviewable diff against one shared base,
rather than two independently-drifting copies of everything." Kustomize's answer is a `base/` plus
per-environment `patches:`; Terraform's is a shared module plus per-workspace variable values. The
staging overlay (`infra/k8s/overlays/staging/kustomization.yaml`) makes the DRY intent explicit in
its own comment, for a reason worth reading precisely: `DEPLOY_ENV`/`SANTIMPAY_ENVIRONMENT` are set
via literal `env:` entries on the patch rather than by patching the shared `ConfigMap`, *because* a
container's own `env:` list takes precedence over the same key sourced from `envFrom` — documented
Kubernetes behavior the overlay leans on specifically so **the base `ConfigMap` stays identical
across every environment**, and each overlay only ever states what it changes. That's the same
discipline a well-designed Terraform module's variables enforce: differences are named, small, and
reviewable in a diff — never a second full copy of the base maintained by hand, which is exactly
the failure mode both tools exist to prevent.

**What this comparison does NOT paper over:** Kustomize only ever operates on Kubernetes manifests
— it has no concept of a VPC, a managed database, or a load balancer, because those live below the
layer Kubernetes itself operates at. The fact that this project got the *Kubernetes-manifest*
layer's DRY problem right is real and worth crediting — and it's precisely why the *infrastructure-
provisioning* layer's absence (§0 above) stands out as sharply as it does: one layer of this exact
problem was solved carefully, the layer underneath it was never started.

---

## 4. Ansible, and where IaC ends and configuration management begins

Terraform (and IaC tools generally) answer "what resources exist" — a VPC exists, a Kubernetes
cluster exists, a managed Postgres instance exists. Ansible (and configuration management tools
generally) answer "what state is a given machine or service in" — this package is installed, this
config file has these contents, this service is running. The boundary matters because reaching for
the wrong tool at the wrong layer produces real friction: provisioning infrastructure with a CM
tool means fighting its assumptions about idempotent, in-place changes to an already-running
target; configuring software with an IaC tool means fighting its assumptions about declarative
resource graphs rather than sequential, stateful steps.

**This project doesn't need Ansible at all, and that's a legitimate, reasoned outcome, not a
gap.** Every piece of "configuration" this project has is either baked into a container image at
build time (Phase 5's multi-stage Dockerfile — the *opposite* of configuring a long-lived machine
after the fact) or expressed as Kubernetes manifests applied declaratively (ConfigMaps, Secrets,
env vars). There's no long-lived VM anywhere in this architecture for Ansible to converge into a
desired state — every workload is either a container built once and run immutably, or a managed
cloud resource IaC would provision. **The rule this teaches:** don't reach for configuration
management because a "real" infrastructure setup is supposed to have one — reach for it when you
have long-lived, mutable machines whose state needs to converge over time, which a fully
containerized, immutable-infrastructure architecture like this one genuinely doesn't.

---

## 5. Cost as a design constraint — and the honest limit of what this phase can say about it

Real infrastructure decisions get made under a budget, and the disciplines that keep that
tractable are themselves concrete: **tagging** every resource with an owner/environment/project so
a cloud bill is attributable rather than a mystery; **budgets and alerts** that page a human before
a runaway resource (an accidentally-unbounded autoscaling group, a forgotten load-test environment
left running) becomes next month's surprise invoice; **right-sizing**, informed by real observed
usage (Phase 5 Lab 5.3's `docker stats`-driven resource-limit exercise is the same discipline,
applied at the container level instead of the cloud-instance level) rather than picking an instance
size by guessing.

**This is the one place in this phase worth being explicit about a limit, not just a gap:** naming
real dollar figures, real instance types, or a specific cloud provider's actual pricing would mean
either inventing numbers with no grounding in this project's real, unmeasured traffic (dishonest in
exactly the way this curriculum has avoided everywhere else) or making a real spending commitment
on the user's behalf that isn't this document's place to make. What's real and statable: this
project's `infra/k8s/base/deployment-web.yaml` already sets real CPU/memory `requests`/`limits` per
pod (worth reading directly — Phase 8 covers this in depth), which is the one piece of
right-sizing input this codebase already has an honest number for; everything above the container
layer — how many nodes, what size, in what region, from which provider — is a decision with a real
cost attached that belongs to whoever is actually paying for it, not to a curriculum document.

---

## Labs

Every lab below is scoped to run locally, at zero cloud cost — deliberately, so practicing these
concepts doesn't require making the provider/budget decision §5 just explained isn't this
document's to make.

### Lab 7.1 — A real Terraform module, provisioning something real, for free

Using Terraform's `docker` provider (not a cloud provider — genuinely local, genuinely free),
write a small module that provisions a Postgres container plus a Docker network, parameterized by
environment name the way a real module would be parameterized by instance size. Instantiate it
twice via two Terraform workspaces (`staging`, `production` — both still entirely local), and
confirm each produces its own independent container with no shared state. Run `terraform plan`
before every `apply` and read it before typing "yes" — the habit matters more than the toy target.

### Lab 7.2 — Reproduce drift, and watch `plan` catch it

After Lab 7.1, `docker exec` into the provisioned Postgres container and change something Terraform
manages directly — a port mapping, an environment variable — by hand, outside Terraform entirely.
Run `terraform plan` again. Confirm it detects and reports the drift accurately, then decide (and
justify your choice) whether the fix is `terraform apply` (overwrite the manual change) or updating
the `.tf` file to match what you changed by hand (accept the manual change as the new desired
state) — both are legitimate resolutions to real drift, and the wrong habit is picking one without
noticing which one you picked.

### Lab 7.3 — Close this project's actual gap, at the design-document level

Don't provision real cloud infrastructure for this one — write the Terraform module *design*
(module boundaries, inputs/outputs, one module per logical unit: networking, cluster, database)
that *would* provision what `infra/k8s/` currently silently assumes exists — a VPC, a Kubernetes
cluster, a managed Postgres instance reachable at whatever `secret.yaml`'s `DATABASE_URL` template
currently just calls `postgres-host`. Get specific about inputs and outputs at each module
boundary; leave the actual provider and instance sizing as an explicit open decision, the same way
this document did in §5 — the point of this lab is closing the *design* gap this phase found, not
making a spending commitment.

---

## Gate — do not proceed to Phase 8 until you can do this cold

1. **This repository has no Terraform. What specific, concrete evidence in `infra/k8s/` reveals
   that something below the Kubernetes layer was assumed to exist but never described anywhere?**
   (No Postgres `StatefulSet`/`PersistentVolumeClaim` anywhere in `infra/k8s/base/`, and
   `secret.yaml`'s `DATABASE_URL` template references a bare `postgres-host` with `sslmode=require`
   — a managed-service hint, never confirmed or acted on anywhere else in the codebase.)
2. **Terraform workspaces and this project's real Kustomize overlays solve the same category of
   problem at different layers. State the problem precisely, and name the layer each operates
   at.** (DRY environment differentiation — a small, reviewable diff against one shared base
   instead of independently drifting full copies; Terraform operates at the cloud-resource-
   provisioning layer, Kustomize at the Kubernetes-manifest layer.)
3. **Why doesn't this project need Ansible, and what would have to change architecturally before
   it did?** (Every workload here is either an immutable container image built once, or a
   declaratively-applied Kubernetes/cloud resource — nothing is a long-lived, mutable machine that
   needs to converge to a desired state over time, which is specifically the problem Ansible
   solves. It would start mattering the moment this architecture introduced a long-lived VM
   Kubernetes doesn't manage.)
4. **What makes `terraform plan` worth treating as a reviewed artifact rather than a formality
   before `apply`?** (It's the actual diff between current and desired state, computed before
   anything happens — the one place a destructive change gets seen by a second person before it's
   real, the infrastructure equivalent of a code review happening before merge instead of after.)
5. **Name the real, concrete decision this project has left unstated regarding its database, and
   the honest tradeoff on each side.** (Managed vs. self-hosted Postgres for staging/production —
   managed costs more monthly and trades away some control for someone else being paged first when
   something breaks; self-hosted costs less directly and makes this project's own team responsible
   for every failure mode its own backup/restore and chaos-drill runbooks already demonstrate real
   competence handling, but for infrastructure nobody has actually stood up yet.)

---

*Next: `08-kubernetes-in-earnest.md` — Phase 8: everything actually deployed in `infra/k8s/` —
probes, HPA, PDB, NetworkPolicy, and the resource requests/limits `deployment-web.yaml` already
sets for real, validated with `kubeconform` since no live cluster has ever run any of it.*
