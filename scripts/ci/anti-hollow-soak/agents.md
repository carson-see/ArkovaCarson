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
> ⚠️ **SUPERSEDED 2026-08-23 — this section describes wiring that no longer exists.**
> Kept verbatim because `agents.md` is append-only (union-merge drop backstop).
> The current wiring is **fail-closed**; see "CI wiring (FAIL-CLOSED)" below.

Wired into `.github/workflows/ci.yml` as the `anti-hollow-soak-report` job under
the W3-freeze CTO carve-out: report-only / warn mode only. The CLI `--report-only`
flag makes `main()` ALWAYS exit 0 (prints `::notice::`/`::warning::` annotations,
never `::error::`); the job step also carries `continue-on-error: true`. It scans
`docs/staging/soak-preflight/*.json` (a convention; none committed yet → notice +
no-op). Fail-closed activation (dropping `--report-only`) is DEFERRED until >=1
real green soak calibrates the guards, mirroring the #1617 T0-CI-infra precedent.

## CI wiring (FAIL-CLOSED) — CURRENT as of 2026-08-23 (SCRUM-2977)
Wired into `.github/workflows/ci.yml` as the `anti-hollow-soak` job (renamed from
`anti-hollow-soak-report`). It still scans `docs/staging/soak-preflight/*.json`
(a convention; none committed yet → notice + no-op), but a hollow signature now
reds the job **and blocks the merge**.

Activation required removing all four hollow mechanisms together — dropping fewer
than all four leaves the gate decorative:

1. the CLI `--report-only` flag (makes `main()` ALWAYS exit 0),
2. the `|| true` on the invocation (discards a non-zero exit),
3. the step's `continue-on-error: true` (a failed step still greens the job),
4. the check's absence from `.mergify.yml` `merge_conditions` — a check Mergify
   does not evaluate can be red while Mergify merges anyway (the same class
   already documented for `Orphaned Export Lint`).

`scripts/ci/soak-integrity-gates-failclosed.test.ts` pins every one of them.

⚠️ Fail-closed `main()` returns the USAGE code **2** when given no `--input`, so
the "no preflight committed" branch in ci.yml must NOT invoke the CLI at all — it
emits a `::notice::` and exits 0. `--report-only` survives only as a local
dry-run opt-in.

Branch-protection required-check status is repo-admin state and is NOT set by
this repo's config — this gate blocks the **Mergify** path; verify branch
protection separately before claiming it blocks anything else.

Run locally:
- unit tests: `npx vitest run scripts/ci/anti-hollow-soak/guards.test.ts`
- CLI report-only: `npx tsx scripts/ci/anti-hollow-soak/guards.ts --report-only --input <preflight.json>`
- CLI as CI runs it (fail-closed): `npx tsx scripts/ci/anti-hollow-soak/guards.ts --input <preflight.json>`

## G-5 — honest N/A for the two anchoring-specific checks (2026-09-12, SCRUM-5054)
CTO decision 2026-09-12 (Confluence 146440221): every T2/T3 soak commits its
preflight JSON under `docs/staging/soak-preflight/` so this fail-closed job
evaluates something real — the directory was empty on main, so the gate was
green by vacuum. But `AntiHollowSoakInput` is anchoring-shaped: `schedulerJob`
(forced-flush OIDC) and `treasury` are meaningless for a train that changes no
anchoring path, and FABRICATING them to fill the file would be worse than the
empty directory.

So `AntiHollowSoakInput.notApplicable?: { schedulerJob?, treasury? }` carries a
written reason, adjudicated by the exported `notApplicableAccepted(reason,
changedPaths)`. An N/A claim is accepted ONLY when all three hold:
1. the reason is a non-empty string,
2. `changedPaths` is non-empty — an undeclared change set can never buy an
   exemption, and
3. NO changed path matches `/anchor|batch|drain|flush|chain|treasury/i`.

Anything else REFUSES the claim: the real check runs and its message is
prefixed `N/A REFUSED: …`, so a refused exemption is visible in the CI log
rather than silent. Accepted N/A passes with the message `N/A: <reason>`.
Checks 1, 4 and 5 (drain attribution, deploy provenance, base-is-main) have no
N/A path — they apply to every soak. `formatReport` is unchanged.

Preflight generator for the CTO Train B rig:
`scripts/staging/targeted/cto-train-b-0912/preflight-from-window.mjs`
(`--window <cycle dir> --manifest <rc json> --deploy-log <json> --base main
--out <path>`). It derives `drainLog` and `changedPaths` from the real
`cycle-*.json` per-PR probe counts — one drain entry per cycle per PR, the
drain path being the probe module that exercised it (`pr-2841-api-keys`) — so
no number in the committed preflight is hand-written. `schedulerJob` and
`treasury` are emitted as `null` with N/A reasons rather than invented; if the
N/A is ever refused, a null job/treasury fails its check, which is the intended
fail-closed direction. When no exported `staging_deploy_log` rows are supplied
it synthesizes ONE row from the manifest's `train_launch_sha` +
`environment.revision` and says so in `_meta.deploy_log_source`.

First committed preflight: `docs/staging/soak-preflight/rc-train-b2-2026-09-12.json`
(RC-2026-09-12-TRAIN-B2) — the directory is no longer empty, so the
fail-closed job now evaluates a real file.
