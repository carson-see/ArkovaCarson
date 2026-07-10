# scripts/staging/

Tooling for the standing `arkova-staging` Supabase rig + `arkova-worker-staging` Cloud Run service. Required by CLAUDE.md §1.11 / §1.12. Authoritative ops doc: [docs/reference/STAGING_RIG.md](../../docs/reference/STAGING_RIG.md).

## What lives here

| File | Purpose |
|---|---|
| `seed.ts` | Synthesize prod-shape data on the staging rig. Tier flag (`--smoke` / `--standard` / `--full`) controls volume. Goes through the `staging_seed_auth_users` RPC (staging-only) so profiles satisfy the `auth.users` FK. Synthetic data only — never copies real customer rows. |
| `load-harness.ts` | Drive sustained synthetic load against the worker. Modes: `anchor`, `burst`, `oscillate`, `webhooks`, `events`, `cron`, `reads`, `mixed` (default). Mixed runs all four pressure types concurrently. Requires `STAGING_API_BASE` to be the per-PR or named train tag URL printed by `deploy.sh`; shared/main staging URLs are refused so parallel soaks don't contaminate each other (SCRUM-1803). **Has NO AI mode** — it never hits `/api/v1/ai/*`. For the AI-path soak use `ai-soak-harness.ts`. |
| `ai-soak-harness.ts` | **AI-path load generator** for the AI T3 soak (SCRUM-2383 re-tiered T2→T3). Drives the LIVE `POST /api/v1/ai/extract` + `/ai/template` + `/ai/tags` at `--rate` (req/hr; default 5000) across **`--doc-variants`** (pdf-clean/scan-ocr/docx-text/large/oversized/malformed — multi-doctype + size stress) using the vendored AI-01 golden corpus. `/api/v1/ai/*` require a **Supabase user JWT** (`STAGING_AI_JWTS`), NOT an API key; `aiRateLimiter` = 30 req/min/user so it **shards across ≥4 JWTs** and `planRate()` fails loud on an undersized pool. Applies a `--timeout-ms` client deadline. Evidence file carries per-endpoint p50/p95/p99, `byVariant`, and a **first-class `reliability` block (429 / timeout / false-reading rates)** — the founders' headline result. Run: `npx tsx scripts/staging/ai-soak-harness.ts …`. |
| `ai-eval-gate-runner.ts` | **Live SCRUM-2382 (AI-02) eval-gate runner.** Continuously samples the 48-entry golden GATE split through the LIVE `/ai/extract` endpoint, scores field F1 with the vendored scorer, enforces weighted F1 ≥ 0.80 + per-field floors (creditHours ≥ 0.85, issuedDate ≥ 0.80, credentialType ≥ 0.80). Appends one JSONL record/round (verdict, weighted F1, per-field P/R/F1, misclassifications, extraction-error count, **`falseReadingCount`** + per-round `reliability`). `--require-live` refuses to certify a round merge-grade if the server-reported provider is `mock`/`fast-fallback`. Fail-closed exit. Run: `npx tsx scripts/staging/ai-eval-gate-runner.ts …`. |
| `ai-eval/` | Shared AI-soak library: `scoring.ts` (vendored port of `services/worker/src/ai/eval/scoring.ts` + the SCRUM-2382 gate from #1413's `eval-gates.ts` — so the soak's F1 equals the merge gate's), `golden-cpe-cle-s3.json` (vendored 60-fixture AI-01 golden set from #1413 @ `b95851d5`, synthetic/PII-free), `golden.ts` (loader), `ai-client.ts` (auth + HTTP + client timeout), `rate.ts` (sharding/pacing), `corpus.ts` (multi-doctype + size document variants), `reliability.ts` (**429/timeout/false-reading classification** — a `false_reading` = degraded/`fast-fallback` 2xx), `harness-core.ts` (stats/payloads/evidence), `eval-core.ts` (score→gate→record). All pure-logic modules have `*.test.ts` (red-first). **Root-cause note:** prod extraction routes to the quota-limited PUBLIC `gemini-2.5-flash` (no `GEMINI_TUNED_MODEL` in `deploy-worker.yml`), not the provisioned Vertex endpoint — the 429 source (see `docs/staging/AI_T3_SOAK_RUNBOOK.md`). Re-vendor when #1413's golden set / gate config changes. |
| `soak-lanes.ts` | Read-only active-lane dashboard. Lists active `screen` soak sessions, latest local evidence summaries, missing final JSON, idle open PRs whose titles indicate `T3`, `migration NNNN`, or `soak PENDING`, and blocked soak candidates with labels such as `do-not-merge`. It recognizes both per-PR sessions (`pr1055-*`) and named train sessions (`train-a-*`, `train-b-*`, `train-c-*`) so release-train soaks stay visible. |
| `claim.sh` | Per-PR lease (multi-tenant after SCRUM-1803). Acquire / release / status the staging-rig lease. Posts to `#eng-staging` if `SLACK_WEBHOOK_URL` is set. |
| `deploy.sh` | **Lease-enforced, tag-routed worker deploys (SCRUM-1803/SCRUM-1821).** Refuses to deploy without a `staging_lease` row for the PR (override with a structured `--force "<Jira>: <reason>"`). Checks image existence (retries to absorb Artifact Registry indexing lag on a fresh push — see below), blocks recent other-PR revisions, gates `--promote` behind the per-day Secret Manager token, deploys with `--tag pr-N --no-traffic` by default or `--lane train-c-*` for named release-train lanes, and writes an audit row to `staging_deploy_log`. Replaces ad-hoc Cloud Run update calls. |
| `cleanup-orphan-tags.sh` | Orphan tag janitor for `pr-*` Cloud Run traffic tags. Uses `gh api` to keep open PRs and removes tags for closed/merged PRs older than 7 days. Dry-run by default; live removal requires `--apply` for Cloud Scheduler / maintenance job use. |
| `rotate-deploy-iam.sh` | SCRUM-1821 item 8 deploy-only IAM rotation. Dry-run by default; live apply requires `--apply --confirm SCRUM-1821`. Creates/uses `arkova-staging-deployer`, grants `roles/artifactregistry.reader` on `arkova-worker-images`, grants conditioned `roles/run.developer` for `arkova-worker-staging`, grants `roles/iam.serviceAccountUser` on the runtime SA, and revokes `roles/run.developer` from the default compute SA. Includes `--rollback`. |
| `migrations/staging_only_deploy_log_and_lease_pk.sql` | **Staging-only schema migration (SCRUM-1803).** Adds PRIMARY KEY to `staging_lease` (one row per PR), creates append-only `staging_deploy_log` audit table, ships `record_staging_deploy` SECURITY DEFINER RPC. Apply via Supabase MCP `apply_migration` to `ujtlwnoqfhtitcmsnrpq` only. Never to prod. |
| `teardown-and-reset.sh` | Lease-aware truncate + migration sync + reseed. Run between PRs. Note: superseded by `seed.ts --reset` (which uses the new `staging_purge_synthetic_data` RPC); keep this script around only for the migration-sync step. |
| `seed-baseline-fixture.sql` | **Baseline fixture for ISOLATED rigs.** Inserts the minimal valid FK chain (`auth.users` → `auth.identities` → `organizations` → `profiles` → one `anchors` row with `status='SUBMITTED'`) so `staging-honesty-preflight.ts` Check 5 passes. Without it a fresh isolated rig has zero SUBMITTED anchors → `fixture_seeded` → HOLLOW soak. **Data-only (§1.11A):** no migration-ledger writes, no `migration repair`; idempotent via `ON CONFLICT (id) DO NOTHING` on `5eed0000-…` fixture ids. Unlike `seed.ts` it inserts `auth.users` directly (isolated rigs lack the `staging_seed_auth_users` RPC). Sets a txn-local `service_role` JWT claim so `protect_anchor_status_transition()` permits the SUBMITTED insert. Run via `supabase db query --linked --file …` (the Mgmt API read-write `/database/query` endpoint is Cloudflare-blocked, HTTP 403 `error code: 1010`, for automated clients). |
| `seed-baseline-fixture.test.ts` | Vitest structural-contract tests for the fixture + its wiring: asserts the SUBMITTED anchor, full FK chain, idempotency, no ledger writes, synthetic ids, and that `provision-isolated-rig.sh` runs the seed after deploy and before the preflight. |
| `provision-isolated-rig.sh` | S0-4.1 / **L2-S2a (SCRUM-2673)** one-command isolated-rig provision (create project → schema replay → deploy worker → **Cloud Scheduler /jobs/\* wiring** → **seed baseline fixture** → `clean_mirror` preflight → `ADMISSION_JSON=...`). `--dry-run` default; live run needs `--apply` + `CONFIRM_PROVISION=<name>`. **`--profile mock\|chain\|gemini`** selects the worker env/secret overlay: `mock` (default, safe: `USE_MOCKS=true`, anchoring off, no Scheduler), `chain` (real anchoring — GetBlock RPC + WIF signer + `KMS_PROVIDER`, Scheduler-driven), `gemini` (real tuned model + prompt; chain mocked, Scheduler-driven). Every profile also wires the boot-critical secrets (Stripe / API-key HMAC / cron / `FRONTEND_URL`) so `config.ts`'s production Zod superRefine does not crash-loop the worker. A live **non-mock** profile requires a second ack `CONFIRM_REAL_CONFIG=<profile>` (real credentials / real Bitcoin exposure). All real credentials are Secret Manager references — never inlined. Hard-denies prod (`vzwyaatejekddvltxyye`) + shared staging. Admission JSON carries SHA/base SHA, image digest, Cloud Run service/tag URL, isolated Supabase ref, preflight result, harness/tool version, owner, and stop conditions. |
| `provision-isolated-rig.test.ts` | Vitest structural + dry-run behavioral contract tests for the profile overlay plumbing (SCRUM-2673): default-mock safety, chain/gemini env-var + secret deltas, all-profiles boot-critical secrets, Cloud Scheduler `/jobs/*` wiring for non-mock profiles, no-inline-credential invariants, and the `CONFIRM_REAL_CONFIG` apply gate. No infra created — every invocation omits `--apply`. |
| `provision-isolated-rig.test.sh` | Dry-run-only shell contract test for the isolated-rig admission JSON. Runs no Supabase/gcloud side-effect commands. |

## Required env

- `STAGING_SUPABASE_URL` — `https://ujtlwnoqfhtitcmsnrpq.supabase.co`. Pull from `gcloud secrets versions access latest --secret=supabase-url-staging --project=arkova1`.
- `STAGING_SUPABASE_SERVICE_ROLE_KEY` — `gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1`.
- `STAGING_API_BASE` — load harness only. Required per-PR or named train tag URL from `deploy.sh` (for example `https://pr-<N>---arkova-worker-staging-...run.app` or `https://train-c-ce---arkova-worker-staging-...run.app`). The harness refuses missing values, shared/main staging URLs, and untagged Cloud Run hosts.
- `STAGING_SUPABASE_DB_URL` — `teardown-and-reset.sh` only — for `supabase db push`.

## Optional env

- `STAGING_AI_JWTS` — **`ai-soak-harness.ts` + `ai-eval-gate-runner.ts` only.** Comma-list of `label:jwt` (or bare jwt) **Supabase user JWTs** for seeded staging users. `/api/v1/ai/*` reject API keys and IAM tokens — only a Supabase user JWT passes `requireAuth`. Supply **≥ 4 distinct users** so the 30 req/min per-user `aiRateLimiter` is not tripped at ≥ 5k req/hr. Mint via a staging login or sign one with the rig's `SUPABASE_JWT_SECRET`. Never logged.
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
- `IMAGE_READABILITY_ATTEMPTS` (default `8`) / `IMAGE_READABILITY_DELAY_SECONDS` (default `5`) — bound `deploy.sh`'s image-readability poll. Artifact Registry does not index a freshly-pushed manifest synchronously, so a single `describe` immediately after `docker push` (the deploy-staging.yml build→deploy gap is ~9s) fails deterministically; `deploy.sh` retries until the push is indexed. Tests set both low to stay fast.
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
export STAGING_API_BASE="https://pr-<N>---arkova-worker-staging-270018525501.us-central1.run.app"
npm run staging:load -- --mode mixed --duration 720 \
  --evidence-out docs/staging/soak-pr-<N>-$(date +%Y%m%dT%H%M).json

# Named release-train lanes use the same lease/audit owner but a train-scoped tag.
./scripts/staging/deploy.sh --pr <N> --lane train-c-ce --image <ref>
export STAGING_API_BASE="https://train-c-ce---arkova-worker-staging-270018525501.us-central1.run.app"

# Check active/idle/blocked soak lanes without mutating GitHub or staging
npm run staging:soak-lanes

# When done
./scripts/staging/claim.sh release <pr-number>

# Weekly/Cloud Scheduler hygiene
./scripts/staging/cleanup-orphan-tags.sh
./scripts/staging/cleanup-orphan-tags.sh --apply

# SCRUM-1821 item 8: review IAM rotation, then apply only with an operator-approved change window
npm run staging:rotate-iam
npm run staging:rotate-iam -- --apply --confirm SCRUM-1821
```

## S0-E4 isolated-rig automation (2026-06-17, story S0-4.1)

- `provision-isolated-rig.sh` / `teardown-isolated-rig.sh` — one-command provision/teardown of a CLEAN isolated soak rig (standalone Supabase project + wired `arkova-worker-<name>-staging` Cloud Run + `clean_mirror` preflight), so multiple T3 trains can soak in parallel without a shared dirty DB (retires roadmap R-3). **`--dry-run` is the DEFAULT**; a live run needs `--apply` + matching `CONFIRM_PROVISION`/`CONFIRM_TEARDOWN`. Prod (`vzwyaatejekddvltxyye`) + shared staging (`ujtlwnoqfhtitcmsnrpq`) + shared Cloud Run services are **hard-denied** (exit 1). The live "2 concurrent soaks" rehearsal is Carson-gated — see the Google Doc "ARKOVA PI-1 S0-E4 — Isolated Soak-Rig Automation Runbook" (Drive ARKOVA PI-1-S0): https://docs.google.com/document/d/1c0F_9NSy9ldfeR28xlY7s7zFFwKpS8cmTzvhI9dI__E/edit

## What this folder does NOT do

- Create the Supabase project itself (`mcp__supabase__create_project` — operator-run, billed).
- Provision the staging Cloud Run service from scratch; current worker deploys go through `scripts/staging/deploy.sh` (see [STAGING_RIG.md](../../docs/reference/STAGING_RIG.md)).
- Run the soak unattended (the engineer / agent who owns the PR drives it).

## Provision Step-4 Scheduler repair (PR #1492, L2-S2a-FIX, 2026-07-10)

`provision-isolated-rig.sh` Step 4 (Cloud Scheduler → `/jobs/*` wiring for non-mock profiles) previously emitted commands that were **invalid under `--apply`**: `--update-headers` on the create verb (create supports only `--headers`), a hand-built `WORKER_URL` with a literal `<hash>`, and a literal `X-Cron-Secret=<from-…>` that was never fetched — so no Scheduler job was ever created and a chain/gemini rig silently degenerated to a health-only soak. Fixed: create-verb `--headers`; `WORKER_URL` via `resolve_cloud_run_url()` (real URL at apply; labeled placeholder only in dry-run echo); cron secret fetched from Secret Manager at apply time and **never printed** (`run_cmd_cron_redacted` redacts every emitted/logged form). The chain-profile `SCHEDULER_JOBS` list now also arms `org-queue-scheduler` (CTO S3.3 memo R3 recorded decision). `provision-isolated-rig.test.ts` gained apply-mode behavioral tests that stub `gcloud`/`npx` on PATH and assert on the exact executed argv — command validity, not dry-run echo text.

## Real batch-drain behavioral harness (#1417, 2026-07-07, Lane-1 chain)

- `batch-drain-harness.ts` (`npx tsx scripts/staging/batch-drain-harness.ts`) + `batch-drain-harness-lib.ts` (pure, unit-tested safety guards). Runs the REAL batch drain against a **properly-configured isolated rig** (`ENABLE_BATCH_ANCHORING=on`, seeded >=10k PENDING) — the exercise fleet-audit found rig #1417 SELF-SKIPPED (batch cron hit its entrypoint but no-op'd on the PR's own `ENABLE_BATCH_ANCHORING=off` gate, so Merkle/intent-persist/reconcile ran ZERO times). Synthetic HTTP load (`load-harness.ts`) proves worker health, NOT that a 10k backlog drains into one Merkle-root OP_RETURN.
- Phases (`--phase seed|drain|proofs|crash|cleanup|all`): SEED >=`--count` PENDING for a synthetic org; DRAIN `POST /jobs/batch-anchors?force=true` (Trigger D) and assert exactly ONE `chain_tx_id` + ONE `merkle_root` across the batch with >=count flipped SUBMITTED/SECURED; PROOFS assert one positional `anchor_proofs` row per leaf (distinct `merkle_index`) — the 2.97M-vs-6,110 proof-gap path; CRASH manufacture a "broadcast-landed-but-submit-never-ran" state (BROADCASTING + `chain_tx_id` set) and assert `recover_stuck_broadcasts` does NOT revert it (the `chain_tx_id IS NULL` guard) so the next drain does not double-broadcast.
- **Safety:** prod ref `vzwyaatejekddvltxyye` is HARD-BLOCKED (`resolveRigTarget`); `STAGING_API_BASE` must be an isolated tag-routed Cloud Run URL (`resolveStagingApiBase` refuses shared/main staging); `--dry-run` validates env + guards without writing. **This script MUTATES a rig DB — never point it at a live/soaking rig; provision a throwaway isolated rig first.**
