# scripts/agents.md

Operational, CI, deployment, and security scripts. Run manually or from CI workflows.

## Key subdirectories
- **`ci/`** — CI gate scripts (has its own agents.md).
- **`gcp-setup/`** — GCP infrastructure provisioning (service accounts, BigQuery, SLOs, Cloud Scheduler).
- **`healthcheck/`** — credential + external-service smoke tests.
- **`ops/`** — operational scripts (pg_cron management, pipeline dashboard cache).
- **`security/`** — license denylist scanner (blocks AGPL/GPL/SSPL).
- **`staging/`** — staging environment tooling (deploy, migrations).
- **`uat/`** — UAT screenshot capture scripts.
- **`admin/`** — admin provisioning scripts (sandbox orgs).

## Top-level files
- **`deploy-worker.sh`** — builds and deploys the worker to Cloud Run. Must use `--platform linux/amd64` and full 40-char SHA.
- **`deploy-edge-worker.sh`** — deploys Cloudflare edge worker via wrangler.
- **`deploy-embed-cdn.sh`** — deploys the embed widget to CDN.
- **`deploy-tunnel.sh`** — deploys Cloudflare Tunnel.
- **`publish-packages.sh`** — publishes SDK packages to npm.
- **`check-copy-terms.ts`** — CI lint for banned UI terminology (Constitution 1.3).
- **`check-homepage-jsonld.test.ts`** — tests for homepage JSON-LD structured data.
- **`enforce-tdd.sh`** — enforces TDD: test must exist before production code.
- **`ci-supabase-start.sh`** — starts Supabase for CI environments.

## Conventions
- Deploy scripts must use `linux/amd64` images and full 40-char Git SHAs.
- CI scripts exit 0 = pass, exit 1 = fail with actionable message.
