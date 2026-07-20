# scripts/ci/anti-hollow-soak/

SCRUM-2977 — anti-hollow-soak guard set. Pre-clock gate: every check here must
pass BEFORE a staging soak clock is allowed to count, so a soak can't burn
wall-time while the changed behavior is never exercised.

## Files
- `guards.ts` — five pure `check*` functions (each returns `{name, pass, message}`),
  the `runAntiHollowSoakGuards(input)` orchestrator, and a CLI entrypoint
  (guarded by `isMainModule`, so importing for tests does not exit).
- `guards.test.ts` — vitest suite; failing-case fixtures for each of the five
  hollow signatures + healthy passing fixtures.

## Hollow signatures caught (2026-07-19 B1 incident family)
1. `non-skip-drain-preflight` — changed-path drain returned EMPTY every cycle
   (e.g. `ENABLE_BATCH_ANCHORING` off).
2. `scheduler-oidc-audience` — forced-flush Cloud Scheduler job missing/mismatched
   OIDC audience → 401 → trigger never fired.
3. `treasury-funded` — rig treasury unfunded → `hasFunds()` skipped the path.
4. `deploy-provenance` — no `public.staging_deploy_log` row for the PR head SHA.
5. `base-is-main-premerge` — PR based on an agent/codex branch, not `main`
   (base-drift, #1367/#1380 family).

## Not wired to CI yet
The workflow wiring (`.github/workflows/`) is intentionally deferred to the
post-train stack; ci.yml is frozen this window. This directory only ships the
guard logic + tests. Run locally with:
`npx vitest run scripts/ci/anti-hollow-soak/guards.test.ts`
