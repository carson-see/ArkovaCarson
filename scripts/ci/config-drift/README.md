# config↔reality drift + cross-runtime parity gate (S0-5.2 SPIKE)

Lane-1 Sprint-0 spike. Retires risk **R-5** (a deploy-config change silently breaks a core feature — the 2026-05-30 env-vs-DB fail-open class, and the mempool.space-provider SPOF class).

## What it does

`scripts/ci/check-config-drift.ts` diffs **asserted** config (what the repo says prod should be) against **running** config (a snapshot of prod), failing CLOSED on drift across **flags / provider / fee-strategy / CSP**, then runs the **cross-runtime parity** harness (`lib/runtimeParity.ts`) comparing the Cloud Run worker vs the Cloudflare edge worker.

- **Asserted** = `expected-prod-config.json` — derived from `deploy-worker.yml` `--set-env-vars`, `services/worker/src/config.ts` defaults, and `vercel.json` CSP connect-src.
- **Running** = `prod-config-snapshot.json` — a reference snapshot of the intended prod state.

Run locally: `npx tsx scripts/ci/check-config-drift.ts` (exit 0 = aligned; exit 1 + `::error::` = drift). Tested by `scripts/ci/check-config-drift.test.ts` + `scripts/ci/lib/runtimeParity.test.ts` (inject synthetic drift → confirm catch).

## SPIKE boundary → Sprint 1

This proves the **mechanism**. Sprint 1 (S0-E5 → VIS-01 / CHAIN-RESIL) hardens it:
1. `loadAssertedConfig` **parses** config.ts / deploy-worker.yml / vercel.json directly (no hand-maintained JSON).
2. `loadRunningSnapshot` becomes a **read-only cron** capture of `GET /health` + the flag registry (never a write; never embeds secrets; PII-scrubbed).
3. The parity harness grows the marked extension points (route contracts, per-route auth mode, rate-limit headers, embedding-model parity).
4. Thresholds shared with the VIS-01 dashboard (see `docs/sprint-0/lane1/visibility-signal-inventory.md`).
