# scripts/staging/

Tooling for the standing `arkova-staging` Supabase rig + `arkova-worker-staging` Cloud Run service. Required by CLAUDE.md §1.11 / §1.12. Authoritative ops doc: [docs/reference/STAGING_RIG.md](../../docs/reference/STAGING_RIG.md).

## What lives here

| File | Purpose |
|---|---|
| `seed.ts` | Synthesize prod-shape data on the staging rig. Tier flag (`--smoke` / `--standard` / `--full`) controls volume. Goes through the `staging_seed_auth_users` RPC (staging-only) so profiles satisfy the `auth.users` FK. Synthetic data only — never copies real customer rows. |
| `load-harness.ts` | Drive sustained synthetic load against the worker. Modes: `anchor`, `burst`, `oscillate`, `webhooks`, `events`, `cron`, `reads`, `mixed` (default). Mixed runs all four pressure types concurrently. Set `STAGING_API_BASE` to the per-PR tag URL printed by `deploy.sh` so parallel soaks don't contaminate each other (SCRUM-1803). |
| `claim.sh` | Per-PR lease (multi-tenant after SCRUM-1803). Acquire / release / status the staging-rig lease. Posts to `#eng-staging` if `SLACK_WEBHOOK_URL` is set. |
| `deploy.sh` | **Lease-enforced, tag-routed worker deploys (SCRUM-1803/SCRUM-1821).** Refuses to deploy without a `staging_lease` row for the PR (override with a structured `--force "<Jira>: <reason>"`). Checks image existence, blocks recent other-PR revisions, gates `--promote` behind the per-day Secret Manager token, deploys with `--tag pr-N --no-traffic`, and writes an audit row to `staging_deploy_log`. Replaces ad-hoc Cloud Run update calls. |
| `cleanup-orphan-tags.sh` | Orphan tag janitor for `pr-*` Cloud Run traffic tags. Uses `gh api` to keep open PRs and removes tags for closed/merged PRs older than 7 days. Dry-run by default; live removal requires `--apply` for Cloud Scheduler / maintenance job use. |
| `rotate-deploy-iam.sh` | SCRUM-1821 item 8 deploy-only IAM rotation. Dry-run by default; live apply requires `--apply --confirm SCRUM-1821`. Creates/uses `arkova-staging-deployer`, grants `roles/artifactregistry.reader` on `arkova-worker-images`, grants conditioned `roles/run.developer` for `arkova-worker-staging`, grants `roles/iam.serviceAccountUser` on the runtime SA, and revokes `roles/run.developer` from the default compute SA. Includes `--rollback`. |
| `migrations/staging_only_deploy_log_and_lease_pk.sql` | **Staging-only schema migration (SCRUM-1803).** Adds PRIMARY KEY to `staging_lease` (one row per PR), creates append-only `staging_deploy_log` audit table, ships `record_staging_deploy` SECURITY DEFINER RPC. Apply via Supabase MCP `apply_migration` to `ujtlwnoqfhtitcmsnrpq` only. Never to prod. |
| `teardown-and-reset.sh` | Lease-aware truncate + migration sync + reseed. Run between PRs. Note: superseded by `seed.ts --reset` (which uses the new `staging_purge_synthetic_data` RPC); keep this script around only for the migration-sync step. |

## Required env

- `STAGING_SUPABASE_URL` — `https://ujtlwnoqfhtitcmsnrpq.supabase.co`. Pull from `gcloud secrets versions access latest --secret=supabase-url-staging --project=arkova1`.
- `STAGING_SUPABASE_SERVICE_ROLE_KEY` — `gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1`.
- `STAGING_API_BASE` — load harness only. Default `https://arkova-worker-staging-kvojbeutfa-uc.a.run.app`.
- `STAGING_SUPABASE_DB_URL` — `teardown-and-reset.sh` only — for `supabase db push`.

## Optional env

- `STAGING_CRON_SECRET` — load-harness `cron` / `mixed` modes. `gcloud secrets versions access latest --secret=cron-secret --project=arkova1`. Without it, cron POSTs return 401 from app-layer auth (still useful soak data — exercises the middleware chain).
- `STAGING_API_KEY` — load-harness `anchor` / `burst` / `reads` modes. A real provisioned API key. Without it, those requests return 401 from auth-key validation (still exercises the auth middleware + rate limiter under load).
- `STAGING_GCP_IDENTITY` — pre-fetched IAM bearer token. Without it, the harness shells out to `gcloud auth print-identity-token` at startup and refreshes every 30 min.
- `STAGING_SUPABASE_PROJECT_REF` — seed-only safety override for explicitly approved isolated staging projects. Default is `ujtlwnoqfhtitcmsnrpq`; prod `vzwyaatejekddvltxyye` is always refused.
- `STAGING_READ_PATHS` — comma-separated override for load-harness `reads`
  mode. Use this when a branch deliberately disables a read endpoint in
  staging; keep the override visible in the PR evidence block so reviewers know
  which paths were exercised.
- `SLACK_WEBHOOK_URL` — `claim.sh` lease notifications.
- `STAGING_PROMOTE_TOKEN` — required only for `deploy.sh --promote`; value must match the current per-day Secret Manager token (`STAGING_PROMOTE_SECRET`, default `staging-promote-token`).
- `STAGING_CLOUD_RUN_HOST` — optional host override used by `claim.sh status` when rendering tag URLs. Default `arkova-worker-staging-270018525501.us-central1.run.app`.
- `STAGING_GCP_PROJECT`, `STAGING_CLOUD_RUN_REGION`, `STAGING_CLOUD_RUN_SERVICE`, `STAGING_ARTIFACT_REPOSITORY`, `STAGING_DEPLOY_SA_ID`, `STAGING_COMPUTE_SA_EMAIL`, `STAGING_RUNTIME_SA_EMAIL` — IAM rotation overrides for `rotate-deploy-iam.sh`.
- `SAMPLE_FROM_PROD=1` + `PROD_SUPABASE_URL` + `PROD_SUPABASE_SERVICE_ROLE_KEY` — read-only sample of prod's status distribution for sizing. (Currently unused by the rewritten seed; the tier flags supersede this.)

## Seed tier matrix

| Tier | orgs | profiles | anchors | public_records | embeddings | total rows | wall time | DB delta |
|---|---|---|---|---|---|---|---|---|
| `--smoke`    | 50     | ~150     | ~600     | 5,000     | 500     | ~10K  | <1 min  | ~10 MB |
| `--standard` | 1,000  | ~5,000   | ~20,000  | 100,000   | 10,000  | ~250K | ~25 min | ~500 MB |
| `--full`     | 10,000 | ~50,000  | ~100,000 | 1,000,000 | 100,000 | ~2M   | ~90 min | ~3 GB |

Default tier is `--standard`. `--full` caps embeddings at 100K (not the spec's 700K) to stay inside Pro tier 8 GB headroom — see code comment for rationale. Use `--reset` to purge before re-seeding (idempotent via `staging_purge_synthetic_data` RPC).

## Staging-only helper RPCs

Created via Supabase MCP `apply_migration` to project_ref `ujtlwnoqfhtitcmsnrpq` only. Migration name: `staging_only_seed_helpers`. **Never apply to prod** (`vzwyaatejekddvltxyye`).

- `staging_seed_auth_users(p_users jsonb)` — bulk-insert `auth.users` rows with `email_confirmed_at = NULL` so the `zz_auth_user_auto_associate_org` trigger is a no-op. Returns count inserted.
- `staging_seed_assign_profile_orgs(p_pairs jsonb)` — bulk-update `profiles.org_id` (the create-profile trigger leaves it null).
- `staging_purge_synthetic_data()` — cascades through synthetic orgs (`org_prefix LIKE 'STG%'`), purges synthetic public records (by source allowlist) + nonces, deletes the `auth.users` rows we created (identified by `raw_app_meta_data->>'provider' = 'staging-synthetic'`).

All three are `SECURITY DEFINER`, granted `EXECUTE` to `service_role` only, revoked from `anon` / `authenticated` / `PUBLIC`.

## Load harness modes

| Mode | Target | Default rate | Auth |
|---|---|---|---|
| `anchor`     | `POST /api/v1/anchor`       | --rate (default 100/min) | IAM + `X-API-Key` |
| `burst`      | `POST /api/v1/anchor`       | --count as fast as possible | IAM + `X-API-Key` |
| `oscillate`  | `POST /api/v1/anchor`       | sawtooth across 3k threshold (Trigger B) | IAM + `X-API-Key` |
| `webhooks`   | `POST /webhooks/{drive,docusign,adobe-sign,checkr}` | 10/min | IAM + provider HMAC headers |
| `events`     | `POST /api/admin/inject-demo-event` | 100/min | IAM |
| `cron`       | `POST /jobs/{batch-anchors,check-confirmations,...}` | every 5 min | IAM + `X-Cron-Secret` |
| `reads`      | `GET /api/v1/verify/...` + `/api/admin/pipeline-stats` | 50/min | IAM + `X-API-Key` |
| `mixed` (default) | webhooks + events + cron + reads concurrently | per above | per above |

Cloud Run service is `--no-allow-unauthenticated`, so EVERY request carries an IAM bearer token in `Authorization`. The harness fetches one at startup and refreshes every 30 min (tokens expire after 1h).

App-layer 401/403 IS valid soak data — it exercises auth middleware, rate limiters, and structured logging under load. To exercise the happy path, set `STAGING_API_KEY` to a real provisioned key.

## Workflow

```bash
# Start of a soak
./scripts/staging/claim.sh acquire <pr-number> "queue rewrite"

# Reseed to known-good
export STAGING_SUPABASE_URL="$(gcloud secrets versions access latest --secret=supabase-url-staging --project=arkova1)"
export STAGING_SUPABASE_SERVICE_ROLE_KEY="$(gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1)"
npm run staging:seed -- --standard --reset

# Apply your migration to staging via Supabase MCP apply_migration
# (NOT supabase db push — see STAGING_RIG.md for the prefix-collision
# rationale).

# Drive load — 12-hour T2 soak with evidence file
export STAGING_CRON_SECRET="$(gcloud secrets versions access latest --secret=cron-secret --project=arkova1)"
npm run staging:load -- --mode mixed --duration 720 \
  --evidence-out docs/staging/soak-pr-<N>-$(date +%Y%m%dT%H%M).json

# When done
./scripts/staging/claim.sh release <pr-number>

# Weekly/Cloud Scheduler hygiene
./scripts/staging/cleanup-orphan-tags.sh
./scripts/staging/cleanup-orphan-tags.sh --apply

# SCRUM-1821 item 8: review IAM rotation, then apply only with an operator-approved change window
npm run staging:rotate-iam
npm run staging:rotate-iam -- --apply --confirm SCRUM-1821
```

## What this folder does NOT do

- Create the Supabase project itself (`mcp__supabase__create_project` — operator-run, billed).
- Provision the staging Cloud Run service from scratch; current worker deploys go through `scripts/staging/deploy.sh` (see [STAGING_RIG.md](../../docs/reference/STAGING_RIG.md)).
- Run the soak unattended (the engineer / agent who owns the PR drives it).
