# Kubernetes manifests

```
infra/k8s/
├── base/                    # environment-agnostic resources
│   ├── namespace.yaml
│   ├── serviceaccount.yaml
│   ├── configmap.yaml       # non-secret config
│   ├── secret.yaml          # TEMPLATE ONLY — see its header comment
│   ├── deployment-web.yaml  # 3 replicas, HPA-scaled, rolling update
│   ├── deployment-worker.yaml # 1 replica — see its comment on why
│   ├── service.yaml          # web (public via Ingress) + worker-metrics (internal only)
│   ├── ingress.yaml
│   ├── hpa-web.yaml
│   ├── pdb.yaml
│   ├── networkpolicy.yaml    # default-deny, then explicit allows
│   ├── job-migrate.yaml      # one-shot `prisma migrate deploy`
│   └── kustomization.yaml
└── overlays/
    ├── staging/      # DEPLOY_ENV=staging, SANTIMPAY_ENVIRONMENT=testbed, 1 replica
    └── production/   # DEPLOY_ENV=production, SANTIMPAY_ENVIRONMENT=production, 3 replicas
```

Validated with:

```bash
kubectl kustomize overlays/staging | kubeconform -strict -summary
kubectl kustomize overlays/production | kubeconform -strict -summary
```

Both render 17/17 valid resources against the real Kubernetes OpenAPI schema — this was
actually run, not just claimed; see the top-level project's verification notes.

## Secrets: what's real here and what isn't

`secret.yaml` is a **template**. In dev/scratch clusters, filling in real values and applying
it directly works. In staging/production, it must never be the source of truth — use one of:

- **External Secrets Operator**, syncing from AWS Secrets Manager / GCP Secret Manager / Vault
  into a Secret with the same name (`santim-web-secrets`) and same keys, so the Deployments
  need zero changes.
- **Sealed Secrets**, encrypting real values asymmetrically so the *ciphertext* is safe to
  commit to git — replace `secret.yaml` with a `SealedSecret` generated via `kubeseal`.

Either way, the private key (`SANTIMPAY_PRIVATE_KEY_B64`) is the highest-value secret in this
system — see `docs/01-santimpay-protocol-spec.md` §1.1 for why (SantimPay holds a copy too, so
it authenticates both outbound requests *and* inbound webhook verification).

## Deploy order

1. Apply everything except the app Deployments start rolling automatically with `kubectl
   apply -k`, but the **migration Job must complete before traffic hits new code**:
   ```bash
   kubectl apply -k overlays/production
   kubectl wait --for=condition=complete job/santim-db-migrate -n santim-commerce --timeout=300s
   kubectl rollout status deployment/santim-web -n santim-commerce
   kubectl rollout status deployment/santim-worker -n santim-commerce
   ```
2. `.github/workflows/deploy.yml` automates exactly this sequence, plus pins the deployed image
   to a content digest (never a mutable tag) and rolls back automatically if the rollout fails.

## Bootstrapping the first admin user

`/admin` is gated by real session-based login (email + password against the `User` table,
role `STAFF`/`ADMIN`) — there is no shared admin password anywhere in this stack's
configuration. After the first deploy to a new environment, create that first account once:

```bash
kubectl exec -n santim-commerce deploy/santim-web -- sh -c \
  "BOOTSTRAP_ADMIN_EMAIL=you@example.et BOOTSTRAP_ADMIN_PASSWORD='a-strong-password' pnpm run create-admin"
```

The script (`apps/web/scripts/create-admin.ts`) upserts by email, so re-running it is also how
you reset a lost admin password without touching the database by hand. It never appears as a
Job manifest here on purpose — a Job template would need the password baked into a spec
(committed or otherwise persisted), whereas this way the credential exists only in the operator's
shell history for the moment it's typed.

## Local testing

No cluster was available in the environment this was built in (validated with `kubeconform`
instead — see above). To actually run it locally:

```bash
kind create cluster --name santim-dev
kubectl apply -k overlays/staging
# Provide real (test) values for secret.yaml first, or your pods will CrashLoopBackOff
# on env.ts's boot-time validation — which is the intended behavior, not a bug.
```

## Prerequisites this assumes

- An `ingress-nginx` controller installed, labeled with `kubernetes.io/metadata.name:
  ingress-nginx` on its namespace (referenced by `networkpolicy.yaml`)
- `cert-manager` with a `ClusterIssuer` named `letsencrypt-production`
- A `monitoring` namespace running Prometheus (referenced by `networkpolicy.yaml` and the
  `prometheus.io/scrape` pod annotations)
- A `data` namespace where Postgres lives (referenced by `networkpolicy.yaml`'s egress rules) —
  adjust if your database runs outside the cluster entirely (RDS, Cloud SQL, etc.), in which
  case that egress rule becomes an allow-to-CIDR rule instead
