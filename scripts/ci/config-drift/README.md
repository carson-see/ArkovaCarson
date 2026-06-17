# config↔reality drift + cross-runtime parity gate (S0-5.2 SPIKE)

Lane-1 Sprint-0 spike. **Scaffolds the mechanism to retire R-5** (a deploy-config change silently breaks a core feature — the env↔DB fail-open class from 2026-05-30, and the mempool.space-provider SPOF class). The live source-parse + `/health` capture that actually *retires* R-5 lands in Sprint 1 (see Limitations) — don't mistake this spike for the mitigation.

## What it does

`scripts/ci/check-config-drift.ts` diffs **asserted** config against a **running** snapshot, failing CLOSED on drift across **flags / provider / fee-strategy / CSP** (a flag *enabled in running but unpinned in asserted* is caught too), then runs the **cross-runtime parity** harness (`lib/runtimeParity.ts`) over the running worker vs edge.

- **Asserted** = `expected-prod-config.json` — the intended **effective** prod config. For kill-switch flags the effective value is the **DB (`switchboard_flags`) resolution, not the raw deploy env var** — e.g. `ENABLE_SEMANTIC_SEARCH` is env=`true` but DB=`false` (fails closed) ⇒ effective `false`. The CSP list is the worker+edge **subset** of `vercel.json` connect-src.
- **Running** = `prod-config-snapshot.json` — a **reference snapshot of intended effective state** (not a live capture). Schema-validated on load → fails closed on a degraded file.

Run locally: `npx tsx scripts/ci/check-config-drift.ts` (exit 0 = aligned; exit 1 + `::error::` = drift). Tested by `scripts/ci/check-config-drift.test.ts` + `scripts/ci/lib/runtimeParity.test.ts` (inject synthetic drift → confirm catch).

## SPIKE boundary → Sprint 1

This proves the **mechanism**. Sprint 1 (S0-E5 → VIS-01 / CHAIN-RESIL) hardens it:
1. `loadAssertedConfig` **parses** config.ts / deploy-worker.yml / vercel.json directly (no hand-maintained JSON).
2. `loadRunningSnapshot` becomes a **read-only cron** capture of `GET /health` + the flag registry (never a write; never embeds secrets; PII-scrubbed).
3. The parity harness grows the marked extension points (route contracts, per-route auth mode, rate-limit headers, embedding-model parity).
4. Thresholds shared with the VIS-01 dashboard (see `docs/sprint-0/lane1/visibility-signal-inventory.md`).
5. **env↔DB modeling** — capture env AND DB per flag so the env↔DB delta (the actual 2026-05-30 fail-open) is the compared dimension; today a flag is a single effective boolean.
6. **Provider-default SPOF** — parse `config.ts` (default `mempool`) + `deploy-worker.yml` (`getblock`) so a dropped env line that silently falls back to `mempool` is caught; today both sides are hand-set to `getblock`.

## Known SPIKE limitations (do not mistake for the mitigation)

- asserted + running are hand-authored committed JSON → the gate is green at rest and cannot yet see a *real* prod divergence;
- parity validates the committed runtime declarations, not a live worker-vs-edge capture;
- the CSP list is a worker+edge subset of the full `vercel.json` connect-src.

All three are resolved by the Sprint-1 source-parse + live `/health` capture above.
