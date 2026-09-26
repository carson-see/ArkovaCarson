# services/worker/scripts/lib

Shared math and statistics utilities for offline scripts.

## Files

- `stats.ts` — `percentile()` helper. Accepts unsorted arrays, handles both 0-1 fractions and 0-100 percentiles. Returns 0 for empty arrays. Used by latency benchmarks and eval harnesses.
- `soak-driver-harness.ts` (PR #3092) — Shared scaffolding for the four T2/T3 soak drivers
  (`pr3083-agent-suspend-keys-driver.ts`, `pr3084-drive-folder-cap-driver.ts`,
  `pr3086-drive-folder-mirror-driver.ts`, `pr3087-supersede-drain-driver.ts`). Extracted after a
  SonarCloud quality-gate failure on PR #3092 (16.9% New Code duplication, gate <=3%; every driver's
  own `main()` also tripped the S3776 cognitive-complexity gate). Exports: `makeProbe` / `aggregateProbes`
  / `tallyProbes` (the shared pass/fail primitive and its aggregation), `parseDriverArgs` (CLI parsing —
  base flags plus an `extraSpecs` hook for a driver's own flags, e.g. pr3087's `--cron-secret`/
  `--bearer-token`), `emitDriverRow` / `readAdmissionJson` (evidence I/O), `resolveSupabaseCredentials` /
  `ensureFixtureAuthUser` / `signInFixtureUser` (fixture identity, idempotent across resumed runs),
  `buildRequestUrl` / `fetchJson` (safe `new URL()`-based target-URL joining — replaces a
  `` `${targetUrl.replace(/\/+$/, '')}${path}` `` string-concatenation pattern that tripped SonarCloud
  tssecurity:S8476/S7044 and the S8786 regex-heuristic finding), `pollUntil` / `sleep`, `ensureOrgWithAdmin`
  (the "one org, one ORG_ADMIN owner" org-lookup-or-create + `profiles`/`org_members` upsert shape every
  driver's own fixture function needed — drivers that need MORE than this, e.g. pr3086's `org_integrations`
  seed or pr3087's extra ORG_MEMBER, call it first and layer their own upserts on top), `runLiveLoop` (the
  deadline/per-cycle-try-catch/exit-status loop), and `runDriverMain`/`DriverProgram` (the WHOLE `main()`
  body — self-test dispatch, the evidence-row shape, and the live-mode setup/loop/exit-status wiring; each
  driver supplies only a `DriverProgram` describing what's actually different about it: its pr/tier/fixture
  shape/cycle logic).
  Two follow-up SonarCloud passes on this file, after the first extraction still left New Code duplication
  at 7.6% (gate <=3%, driven by every driver hand-rolling an identical `buildRow` + `main()` body — see
  `runDriverMain` above) and two more findings HERE: S1121 ("extract the assignment of i" — the CLI-parsing
  loop rewrote `argv[i += 1]` as a separate `i += 1` statement before reading `argv[i]`, every occurrence)
  and S7744 ("the empty object is useless" — `...(init.headers ?? {})` in `fetchJson` simplified to
  `...init.headers`, since spreading `undefined` is a documented no-op).
  Behavior is unchanged throughout: every function is a byte-for-byte extraction of what each driver
  already did (fresh fixture sign-in every cycle, `process.exitCode = 1` on any failed probe, self-test
  rows marked `evidenceForSoak:false`). Never import this from `services/worker/src/` — offline tooling
  only, same constraint as everything else in `scripts/`.


## 2026-09-05 — owned PostgreSQL test clusters

`local_postgres.py` provides a context-managed PostgreSQL17 cluster for offline SQL regressions. It requires an explicit binary directory and a new output directory, uses a private Unix socket, verifies process ownership before cleanup, and retains SQL/output evidence. It never connects to an existing database. Its focused consumers do not claim a full production-schema replay. The private socket directory comes from `ARKOVA_PG_SOCKET_DIR` or `tempfile.gettempdir()` (never a hardcoded `/tmp` — Sonar python:S5443); the constructor fails loudly if the resulting socket path would exceed the `sun_path` limit, so point `ARKOVA_PG_SOCKET_DIR` at a short directory if your `TMPDIR` is long.
