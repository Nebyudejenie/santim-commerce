# Local Prometheus scrape credentials

Prometheus's `credentials_file` directive (used in `../prometheus.yml`) reads a bearer token
from a plain file at scrape time — this is the actual supported mechanism for keeping a
secret out of the YAML config itself, since Prometheus does not expand `${VAR}` placeholders
in its own config.

Create the file this directory expects, matching the `METRICS_TOKEN` you set for the app:

```bash
echo -n "$METRICS_TOKEN" > infra/observability/secrets/metrics-token.txt
```

`metrics-token.txt` is gitignored — never commit a real token. In Kubernetes, the equivalent
is mounting the `santim-web-secrets` Secret's `METRICS_TOKEN` key as a file via a volume,
rather than recreating this directory structure.
