# agents.md — services/worker/src/jobs/
_Last updated: 2026-05-08_

## What This Folder Contains

Cron job handlers invoked by Cloud Scheduler. Each export is registered in `src/index.ts` as a `/jobs/<name>` POST route, authenticated via `X-Cron-Secret` header.

## Key Files

- **treasury-cache.ts** — `refreshTreasuryCache()`. Fetches treasury balance (mempool.space), BTC price, fee rates, UTXO count, network info, and anchor stats, then upserts into `treasury_cache` singleton (id=1). Called every 10 min. SCRUM-1786: sentinel guard prevents -1 from overwriting last-good cached values.
- **anchor.ts** — `processAnchors()`. Core anchoring lifecycle — picks SUBMITTED anchors, broadcasts to Bitcoin, confirms on-chain.
- **batch-anchor.ts** — `batchAnchors()`. Batch processing for high-volume anchor submission.
- **check-confirmations.ts** — Polls Bitcoin for confirmation of previously-broadcast transactions.
- **process-revocations.ts** — Processes anchor revocation requests.

## Architecture Decisions

- **Treasury cache sentinel guard** (SCRUM-1786): Before upserting, if any of `total_secured`, `total_pending`, `last_24h_count` is -1, read existing cache row and preserve last-good values. Defense-in-depth against upstream failures (pipeline_dashboard_cache unavailable, anchors query timeout).
- **Anchor stats from pipeline_dashboard_cache** (SCRUM-1786): `fetchAnchorStats()` (in `../utils/anchor-stats.ts`) reads from `pipeline_dashboard_cache` instead of the `get_anchor_status_counts_fast` RPC. The RPC's 1s per-status timeouts produced -1 sentinels on the 2.9M-row anchors table.

## Do / Don't Rules

- **DO** authenticate all job routes with `X-Cron-Secret` — never expose jobs unauthenticated.
- **DO** use `Promise.allSettled` for parallel external calls — one failure must not crash the job.
- **DON'T** call real Bitcoin or Stripe APIs in tests — mock interfaces only (CLAUDE.md §1.7).
- **DON'T** set `anchor.status = 'SECURED'` from client code — worker-only via service_role (CLAUDE.md §1.4).
