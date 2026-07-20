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
5. ✅ **env↔DB flag fail-open SPOF — DONE (S1, Lane-2).** `config-drift/flagSpof.ts` parses the REAL `deploy-worker.yml` `--set-env-vars` flags + the REAL `flagRegistry.ts` `DB_FLAGS` list and classifies the env↔DB delta against the asserted `flags`. `flagRegistry` resolves a DB-backed flag to its env var when the `switchboard_flags` row is **absent**, so a flag asserted effective=`false` but env=`true` fails **OPEN** (the 2026-05-30 class). Findings: `fail-open-flag` (DB-backed, asserted-OFF/env-ON — OFF rests on a DB row), `env-flag-on-no-db-guard` (asserted-OFF/env-ON but NOT DB-backed — no kill switch at all), `launch-flag-off` (a `launchRequiredFlags` flag the deploy sets false/omits — launch-path break). Wired into `check-config-drift.ts` main() with a **two-tier** calibration (the providerSpof latent-SPOF precedent): a flag in the manifest's `acknowledgedFailOpenFlags` (known env-ON, held OFF today only by a live DB row; the deploy fix is a T3/Carson chain-adjacent change) is a non-blocking `::warning::`; a **NEW, unacknowledged** fail-open flag — or any `launch-flag-off` / `env-flag-on-no-db-guard` — is a hard **ERROR** that fails CI. The live tree sets `ENABLE_SEMANTIC_SEARCH=true` + `ENABLE_AI_FRAUD=true` in `deploy-worker.yml` while both are asserted effective=`false`; both are acknowledged (warnings) so the gate is green at rest, the hazard is auditable, and the regression guard is live. Recommended fail-safe follow-up (T3 / Carson): set `ENABLE_SEMANTIC_SEARCH=false` + `ENABLE_AI_FRAUD=false` in `deploy-worker.yml` so they fail SAFE regardless of the DB row, then drop them from `acknowledgedFailOpenFlags`. The **CSP-vs-runtime-deps** dimension (a CSP-breaking dependency — the 06-16 §1.6 regression) is owned by WEBEXT-04's `scripts/ci/check-csp-runtime-deps.ts` (PR #1262); this gate covers the CSP **connect-src** allowlist (bidirectional, above), so the two are complementary, not duplicated. 13 tests (`flagSpof.test.ts`) incl. real-tree smoke, plus the wiring + regression-guard tests in `check-config-drift.test.ts`.
6. ✅ **Provider-default SPOF — DONE (S1.5).** `config-drift/providerSpof.ts` parses the REAL `config.ts` default (`mempool`) + `deploy-worker.yml` override (`getblock`) and is wired into `check-config-drift.ts` main(): a dropped env line (silent fallback to a non-asserted provider) **or** a wrong override **fails CI**; a latent code-default divergence the deploy currently masks surfaces as a non-blocking `::warning::`. 11 tests (`providerSpof.test.ts`) incl. real-tree smoke. Fail-safe follow-up (recommended): align the `config.ts` default to the asserted provider so a dropped override fails safe — a chain-touching change, T3 / Carson-gated.

## `pendingLaunchFlags` — staged pins (WH-6, SCRUM-2899)

`expected-prod-config.json` may carry a `pendingLaunchFlags: string[]` key for launch-required flags that are specced/coded but **not yet flipped on in prod**. It is INERT: `check-config-drift.ts` reads it nowhere (Zod `.passthrough()` tolerates it; neither `diffConfigState` nor `flagSpof` consumes it), so it does not affect the gate. A flag here is NOT in `flags`/`launchRequiredFlags` on purpose — pinning it there while `deploy-worker.yml` still omits it would fire `flag-SPOF launch-flag-off` + a drift `absent from running` and turn CI red before the flag is actually live. To **activate** (Carson, post-soak + prod flip): move the flag into `flags: true` + `launchRequiredFlags`, add it to `prod-config-snapshot.json` `flags: true`, and add `<FLAG>=true` to `deploy-worker.yml --set-env-vars` so it fails SAFE. First entry: `ENABLE_OUTBOUND_WEBHOOKS` (webhook delivery kill switch).

## Known SPIKE limitations (do not mistake for the mitigation)

- asserted + running are hand-authored committed JSON → the *CSP / fee* dimensions are green at rest and cannot yet see a *real* prod divergence. The **provider** dimension reads real source via `providerSpof.ts` (item #6), and the **flag env↔DB fail-open** dimension reads real source via `flagSpof.ts` (item #5) — both now catch a real source-side regression at PR time; the remaining gap is the *running*-side live capture (Sprint-1 `/health` cron);
- parity validates the committed runtime declarations, not a live worker-vs-edge capture;
- the CSP list is a worker+edge subset of the full `vercel.json` connect-src.

All three are resolved by the Sprint-1 source-parse + live `/health` capture above.
