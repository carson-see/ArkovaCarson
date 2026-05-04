# Staging Rig

Standing infrastructure used to soak every prod-bound change before merge. Required by [CLAUDE.md §1.11 / §1.12](../../CLAUDE.md).

## Components

| Component | Where | Cost (approx) |
|---|---|---|
| Supabase preview branch `arkova-staging` | Project `vzwyaatejekddvltxyye` | $0.32/hr active, $0 paused; auto-pause off-hours |
| Cloud Run service `arkova-worker-staging` | GCP project `arkova-prod` (region `us-central1`) | scale-to-zero; ~$0/mo idle |
| Tooling | `scripts/staging/` | n/a |
| CI gate | `.github/workflows/staging-evidence.yml` | n/a |
| `staging_lease` table | On the staging branch | n/a |

Estimated all-in: **$80–$120/month** at typical utilization.

## One-time setup (operator)

1. **Create the Supabase branch** via the Supabase MCP `create_branch` tool. Capture the new connection string + service role key.
2. **Store creds in GCP Secret Manager** under names:
   - `arkova-staging-supabase-url`
   - `arkova-staging-supabase-service-role-key`
   - `arkova-staging-supabase-db-url`
3. **Create the Cloud Run service** `arkova-worker-staging` from the same image as `arkova-worker`, but with env:
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` → from the staging secrets above
   - `BITCOIN_NETWORK=signet`
   - `ENABLE_PROD_NETWORK_ANCHORING=false`
   - `ENABLE_AI_FRAUD=false`
   - `min-instances=0` (scale to zero when idle)
4. **Apply schema** from current `main`:
   ```bash
   STAGING_SUPABASE_DB_URL=... npx supabase db push --db-url "$STAGING_SUPABASE_DB_URL"
   ```
5. **Create `staging_lease` table** on the staging branch (DDL is in this folder under `staging_lease.sql`).
6. **Seed initial data**:
   ```bash
   STAGING_SUPABASE_URL=... STAGING_SUPABASE_SERVICE_ROLE_KEY=... npm run staging:seed
   ```
7. **Create one API key per seeded org** via the worker's normal API-key endpoint, store the comma-separated list as `arkova-staging-api-keys` in Secret Manager.

## Per-PR workflow

```bash
# 1. Acquire the lease.
./scripts/staging/claim.sh acquire 1234 "queue rewrite"

# 2. Reset to a known-good state.
./scripts/staging/teardown-and-reset.sh

# 3. Apply your migration to staging via Supabase MCP, then deploy
#    arkova-worker-staging at your branch SHA:
gcloud run deploy arkova-worker-staging \
  --image us-central1-docker.pkg.dev/arkova-prod/arkova/worker:<your-sha> \
  --region us-central1

# 4. Drive load for the soak window.
npm run staging:load -- --mode oscillate --duration 240   # T3
# or
npm run staging:load -- --mode burst --count 12000        # T3 trigger A
# or
npm run staging:load -- --mode steady --rate 50 --duration 30   # T1 smoke

# 5. Capture evidence in PR body under `## Staging Soak Evidence`.
#    See PR_TEMPLATE.md.

# 6. Release the lease when done.
./scripts/staging/claim.sh release 1234
```

## Tier examples

| Change | Tier | Why |
|---|---|---|
| Copy fix in `src/lib/copy.ts` | T1 | Frontend-only, no DB, no worker logic |
| New v1 read endpoint with no DB write | T2 | Public API surface |
| New SECURITY DEFINER function migration | T2 | Schema change |
| Rewrite of `batch-anchor.ts` triggers | T3 | Anchor lifecycle |
| New cron that polls `anchors` every 5 min | T3 | Cron on chain hot path |
| Stripe webhook handler change | T3 | Entitlements |

## What goes in `## Staging Soak Evidence`

Use [PR_TEMPLATE.md](./PR_TEMPLATE.md). Fields are line-anchored, so format matters — `Tier: T3` works, `tier=T3` does not.

## Cost controls

- **Auto-pause**: a separate cron (in `arkova-worker-staging` itself) checks if the lease is empty AND no harness has hit the API in the last 30 min, and if so, calls Supabase `pause_branch` MCP. Wakes on the next API hit.
- **Lease hygiene**: leases >72h old are evicted by `claim.sh acquire` automatically.
- **Hard ceiling**: alert fires (PagerDuty `staging-cost-overrun`) if monthly Supabase branch hours exceed 250.

## Teardown

The standing rig is meant to live indefinitely. Teardown is for emergencies (compromise, runaway cost):

```bash
gcloud run services delete arkova-worker-staging --region us-central1
# Then via Supabase MCP delete_branch on arkova-staging
# Then revoke the staging service role key
```
