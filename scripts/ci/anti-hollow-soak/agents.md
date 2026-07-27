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
   (e.g. `ENABLE_BATCH_ANCHORING` off). **G-4:** a productive cycle is not
   enough — when `changedPaths` is declared, the productive work must be
   attributed (via `DrainCycle.path`) to one of the PR's changed paths, so the
   check can distinguish real changed-behavior coverage from generic synthetic
   load keeping a rig busy on an unrelated queue. Omit/empty `changedPaths` =
   legacy attribution-unaware pass, but with an explicit caveat in the message.
2. `scheduler-oidc-audience` — forced-flush Cloud Scheduler job missing/mismatched
   OIDC audience → 401 → trigger never fired. **G-3:** compare `URL(uri).origin`
   vs `URL(audience).origin`, NOT the full uri+path. Cloud Run's OIDC audience is
   the service ORIGIN while `httpTarget.uri` carries the invoked path
   (`/jobs/flush`) — a naive full-URI equality check false-fails every healthy
   job. Unparseable uri/audience fails closed.
3. `treasury-funded` — rig treasury unfunded → `hasFunds()` skipped the path.
4. `deploy-provenance` — no `public.staging_deploy_log` row for the PR head SHA.
5. `base-is-main-premerge` — PR based on an agent/codex branch, not `main`
   (base-drift, #1367/#1380 family).

## CI wiring (REPORT-ONLY / non-gating)
Wired into `.github/workflows/ci.yml` as the `anti-hollow-soak-report` job under
the W3-freeze CTO carve-out: report-only / warn mode only. The CLI `--report-only`
flag makes `main()` ALWAYS exit 0 (prints `::notice::`/`::warning::` annotations,
never `::error::`); the job step also carries `continue-on-error: true`. It scans
`docs/staging/soak-preflight/*.json` (a convention; none committed yet → notice +
no-op). Fail-closed activation (dropping `--report-only`) is DEFERRED until >=1
real green soak calibrates the guards, mirroring the #1617 T0-CI-infra precedent.

Run locally:
- unit tests: `npx vitest run scripts/ci/anti-hollow-soak/guards.test.ts`
- CLI report-only: `npx tsx scripts/ci/anti-hollow-soak/guards.ts --report-only --input <preflight.json>`
