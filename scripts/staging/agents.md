# scripts/staging/

Tooling for the standing Supabase preview branch (`arkova-staging`) used to soak every prod-bound change before it merges. Required by CLAUDE.md §1.11 / §1.12.

## What lives here

| File | Purpose |
|---|---|
| `seed.ts` | Synthesize prod-shape data (orgs, members, anchors with realistic status distribution). Never copies real customer rows. |
| `load-harness.ts` | Fire synthetic anchors at the staging worker in `burst`, `steady`, `oscillate`, or `multitenant` modes. |
| `claim.sh` | Acquire / release / status the staging-rig lease. Posts to `#eng-staging` if `SLACK_WEBHOOK_URL` is set. |
| `teardown-and-reset.sh` | Truncate soak-test tables + reapply migrations + reseed. Run between PRs. |

## Required env

- `STAGING_SUPABASE_URL`
- `STAGING_SUPABASE_SERVICE_ROLE_KEY`
- `STAGING_API_BASE` (load harness only — Cloud Run URL of `arkova-worker-staging`)
- `STAGING_API_KEYS` (comma-separated; one per seeded org)
- `STAGING_SUPABASE_DB_URL` (teardown only — for `supabase db push`)

Optional:
- `SAMPLE_FROM_PROD=1` + `PROD_SUPABASE_URL` + `PROD_SUPABASE_SERVICE_ROLE_KEY` — read-only sample of prod's status distribution to size the synthesis.
- `SLACK_WEBHOOK_URL` — lease acquire/release notifications.

## Workflow

```bash
# Start of a soak
./scripts/staging/claim.sh acquire <pr-number> "queue rewrite"

# Reset to known-good
./scripts/staging/teardown-and-reset.sh

# Apply your migration to staging via the Supabase MCP, then deploy
# arkova-worker-staging at your branch SHA.

# Drive load
npm run staging:load -- --mode burst --count 12000
# ... or for the queue-rewrite soak ...
npm run staging:load -- --mode oscillate --duration 240

# When done
./scripts/staging/claim.sh release <pr-number>
```

## What this folder does NOT do

- Create the Supabase branch itself (that's `mcp__supabase__create_branch` — operator-run, billed).
- Deploy the staging worker (that's `gcloud run deploy arkova-worker-staging` per `docs/staging/README.md`).
- Run the soak unattended (that's the engineer / agent who owns the PR).
