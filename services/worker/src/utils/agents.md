# agents.md — services/worker/src/utils/
_Last updated: 2026-05-08_

## What This Folder Contains

Shared utility modules for the worker service: database client, logger, RPC helpers, anchor stats fetcher, and other cross-cutting concerns.

## Key Files

- **db.ts** — Supabase client (service_role). All worker DB access flows through this.
- **logger.ts** — Pino logger with PII scrubbing. Every log call must avoid user emails, document fingerprints, API keys (CLAUDE.md §1.4).
- **anchor-stats.ts** — `fetchAnchorStats()` shared by treasury-cache cron and treasury status API. SCRUM-1786: reads per-status counts from `pipeline_dashboard_cache` (refreshed every 2 min via `pg_class.reltuples`) instead of the `get_anchor_status_counts_fast` RPC (1s timeouts on 2.9M-row anchors).
- **rpc.ts** — Typed RPC caller (`callRpc<T>`). Still used by health check, admin-stats, batch-anchor, mainnet-migration for `get_anchor_status_counts_fast`.

## Architecture Decisions

- **anchor-stats reads pipeline_dashboard_cache** (SCRUM-1786): The `get_anchor_status_counts_fast` RPC's per-status `SET LOCAL statement_timeout = '1000'` routinely timed out on the bloated anchors table (2.9M rows). `pipeline_dashboard_cache` already has the answer via `pg_class.reltuples` — instant, no timeout. The -1 sentinel convention is preserved for callers that can't reach the cache.
- **Sentinel -1 contract**: When a stats value can't be measured this round, return -1. Callers (treasury-cache.ts) must check for -1 and preserve last-good values.

## Do / Don't Rules

- **DO** use `db` from this folder for all Supabase access — never construct a new client.
- **DO** use `logger` — never `console.log`.
- **DON'T** import browser-only modules (`generateFingerprint`, `piiStripper`) — worker boundary (CLAUDE.md §1.6).
- **DON'T** log PII (emails, fingerprints, API keys) — Sentry scrubbing is last resort, not first line.
