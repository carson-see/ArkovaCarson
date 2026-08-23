# PR #2291 Node 22 — T2 soak maturity record, clock closed <<FILL: confirm 2026-08-23T09:27:29Z or actual capture time>>

> TEMPLATE (pre-staged 2026-08-23 while the window was running). Every `<<FILL>>`
> marker is a close-time number that `close-capture.sh` prints into its
> `summary.md`; everything else was already true at pre-stage time and was
> verified against the rig, not copied from the stand-up doc. When filled,
> rename to `maturity-<closeUTC>.md` and drop this note.

**Rig:** `arkova-worker-node22-staging`, revision `arkova-worker-node22-staging-00001-8md`, tag `pr-2291`
**Image digest:** `sha256:c6f51425d50744c8aeecf439dafae2b5055567ad440b9e891dae617f9d652556` (sole linux/amd64 manifest of pushed index `sha256:0d087223…`)
**Worker `git_sha` (from `/health`):** `f41192e061d72ef8866f19dbd50c16593ccbca23` — equals the frozen PR head
**Supabase:** `yklabujmzhzbvnhovcjt` (`arkova-node22-2026-08`, us-east-2) — isolated, provisioned 2026-08-22 for this window
**Declared tier:** T2 — worker behavior / public API surface (runtime swap `node:20-alpine` → `node:22-alpine`)
**Revision clock start (FD-CLOCK-1):** 2026-08-22T21:27:29.654107Z
**Clock close:** 2026-08-23T09:27:29Z — **12.00 h, the full T2 minimum**
**Network label:** `/health` reports `network: mainnet`, but `ENABLE_PROD_NETWORK_ANCHORING=false` and no treasury WIF is mounted (`kms: warning` is expected) — zero chain exposure by design; #2291 changes the runtime, not the signer.

## Verdict

<<FILL: one paragraph. Write it FROM the numbers below after they are in — clock
integrity result, coverage %, 5xx count, driver fail count. Do not write it first.>>

## Clock integrity — <<FILL: PASSES / FAILS>> (FD-CLOCK-1)

| Condition | Observed |
|---|---|
| Serving revision | `arkova-worker-node22-staging-00001-8md` |
| Revision created | 2026-08-22T21:27:29.654107Z |
| Revision at close | <<FILL: unchanged / CHANGED — from close-capture §2>> |
| Revisions that served requests in-window | <<FILL: from close-capture §3 distinct list + total sampled>> |
| Traffic | <<FILL: expect 100 %, tag `pr-2291`, single revision — close-capture §2>> |
| Container terminations / OOM | <<FILL: close-capture §4>> |
| 5xx across the 12 h window | <<FILL: close-capture §5 total>> |
| Health at close | <<FILL: 5× HTTP + timings from close-capture §1, e.g. "5/5 × HTTP 200 (0.30–1.3 s)">> |

The clock is the serving revision's `creationTimestamp`, not instance uptime. `/health`
`uptime` is the current *instance*, which Cloud Run recycles mid-window; reading it as
the clock understates the window (instance uptime was already reset at least once
mid-window: `uptime=21213` s observed at 03:24Z, ~5.9 h into the window).

## Load coverage

Computed from Cloud Run request logs across the whole window (not from local driver
logs), pulled in **2-hour slices with per-slice counts printed** so a 20,000-entry read
cap cannot silently truncate a slice (offered load ~19/min ⇒ ~2,280 entries/slice —
nowhere near the cap; a cap hit means something else was hammering the rig and must be
explained, not averaged away).

| | |
|---|---|
| Requests in window (log-side) | <<FILL: close-capture §3 total>> |
| Per-2h-slice counts | <<FILL: paste the six slice lines>> |
| Driver-side sustained cycles | <<FILL: driver-rollup `sustained.cycles` — 13 at 03:07Z, expect ~28 by close>> |
| Driver totals ok/fail | <<FILL: `sustained.ok` / `sustained.fail`>> |
| status_200 / 404 / 401 / 429 / other | <<FILL: from driver-rollup>> |
| coldStartRetries (bounded, counted) | <<FILL: 1 as of 03:07Z (23:20Z cycle); final from roll-up>> |
| Deviations | <<FILL: expect empty for sustained cycles>> |
| Supervisor rc history | <<FILL: expect all rc=0 + "supervisor done"; any nonzero = gap, explain it>> |

**Offered-load design (fixed at stand-up, not a close-time number):** core pass
(`health` + 2 verify shapes) every 10 s ≈ 18/min, member block (declared-404,
declared-401 HMAC-reject, cron db-health via `X-Cron-Secret`) every 5 min ≈ 1/min —
**~19/min sustained against the code-enforced 60 req/min/IP `apiIpShadowGuard`
ceiling** (the doc's §1.10 100/min figure is not what the code enforces). `429` has a
dedicated counter, so limiter pressure cannot hide in `status_other`.

**Driver verification runs (pre-window-supervisor, disclosed):** run 1 (200 s,
21:37:48Z) failed by design — `2291-cron-dbhealth=200/predicate ×2`, the fresh-rig
dead-tuple-ratio artifact on a near-empty `job_queue`; predicate rewritten to assert the
real signals (any cronFailure, smoke streak, or non-dead-tuple alert still fails). Run 2
(130 s, 21:40:34Z): 39 ok / 0 fail. Sustained supervision started 21:40:40Z.

## 5xx

<<FILL: from close-capture §5. If zero: state "Zero 5xx in the 12 h window" and note the
one absorbed cold-start retry (23:20Z cycle, counted in coldStartRetries, want=200 answered
on retry). If nonzero: per-status/per-path table + timestamps + cause + whether confined
and self-recovered, in the style of the fullsoak-2026-08 record — assert confinement, not
harmlessness.>>

## Environment basis — `clean_mirror`, isolated project, preflight at the PR head

Preflight ran 2026-08-22T21:30:27Z (3 minutes after clock start) against
`yklabujmzhzbvnhovcjt` with `--prod-project-ref vzwyaatejekddvltxyye`, using the
post-#2319 checker executed from the #2291-head worktree so `loadRepoMigrationVersions()`
read the PR's own migration set. **`environment_type = clean_mirror`, exit 0, 8/8
checks.** Verbatim:

```json
{
  "environment_type": "clean_mirror",
  "staging_project_ref": "yklabujmzhzbvnhovcjt",
  "timestamp": "2026-08-22T21:30:27.047Z",
  "checks": [
    { "name": "staging_only_rows", "passed": true, "details": "No PR-only or staging-only migration rows found." },
    { "name": "duplicate_names", "passed": true, "details": "No duplicate migration names." },
    { "name": "duplicate_versions", "passed": true, "details": "No duplicate migration versions." },
    { "name": "known_artifacts", "passed": true, "details": "No known artifact rows." },
    { "name": "submitted_anchors", "passed": true, "details": "1 SUBMITTED anchor(s) found." },
    { "name": "prod_divergence", "passed": true, "details": "Rig ledger reconciles with repo migration files + canonical baseline. 4 pre-baseline/version-shape prod row(s) subsumed by the canonical baseline (informational)." },
    { "name": "org_topology", "passed": true, "details": "1 org(s), no staging seed orgs — prod-like single-tenant topology." },
    { "name": "prod_facts", "passed": true, "details": "Prod facts verified: vacuum-anchors scheduled, refresh_pipeline_dashboard_cache exists, refresh-pipeline-dashboard-cache scheduled." }
  ],
  "artifact_rows": [],
  "missing_from_staging": ["0410", "0411", "0412", "0413"],
  "extra_vs_prod": []
}
```

`missing_from_staging` 0410–0413 are prod-ahead rows owned by unmerged PRs — reported as
informational by design, not rig contamination. Schema: 112 files replayed to numeric
head `0414` (matching `main`); three files (`0366`, `0381`, `0389`) had ` CONCURRENTLY`
stripped because the Management API wraps every request in a transaction — identical
resulting index on a greenfield rig, disclosed in the stand-up doc with per-file md5s
(`replay-log-2026-08-22.json`).

## Node 22 runtime proof — measured at stand-up, not asserted

The claim under soak is the runtime itself; it was proven three ways at stand-up
(2026-08-22, full detail in `soak-start-2026-08-22T2127Z.md`):

1. **Deployed-digest execution:** the digest Cloud Run reports for `00001-8md`
   (`status.imageDigest = sha256:c6f51425…`) pulled back and executed under
   `--platform linux/amd64` → `deployed-digest runtime: v22.23.1`.
2. **Runtime fingerprint** of the same image:
   `{"node":"v22.23.1","platform":"linux","arch":"x64","undici":"6.27.0","openssl":"3.5.7","v8":"12.4.254.21-node.56"}` —
   `v22.23.1 >= 22.19.0` satisfies #2291's `engines` floor.
3. **Digest chain:** pushed OCI index `sha256:0d087223…` contains exactly one platform
   manifest, `linux/amd64 = sha256:c6f51425…`, byte-identical to the revision's
   `status.imageDigest`. The container that served this soak IS the image that prints
   `v22.23.1`.

What the 12 h load then adds: that runtime **under sustained authenticated traffic** —
Express routing, supabase-js over global fetch (undici) with keep-alive pooling, zlib
(`--compressed`), the api-key HMAC reject path (crypto), and in-process cron fired via
`X-Cron-Secret` — every 10 s for 12 h with declared-status probes and jq predicates on
every body.

## §1.12 T2 requirements — met / unmet

| Requirement | Status |
|---|---|
| 12 h soak at the exact frozen head | <<FILL: met/broken — clock table above>> |
| Merge-grade staging evidence w/ exact head + base SHA | Met — head `f41192e0…`, merge-base `253c9999…`, evidence in this dir |
| Clean preflight | Met — `clean_mirror` 8/8 at 21:30:27Z, verbatim above |
| Evidence exercises the PR's changed path | Met — the changed path IS the runtime; every probe traverses it (see runtime-proof section). Generic-load caveat does not bite: the probes assert content, declared 401/404 semantics, and cron execution, not just liveness |
| E2E result | <<FILL: CI E2E run URL for head f41192e0… + result>> |
| Rollback rehearsal | <<FILL: PLANNED at close via rollback-rehearsal.sh (deploy current main-head Node 20 image to this service as a new revision — post-close ONLY, the deploy moves latestRevision and would reset the clock if run mid-window — verify /health 200 + digest-executed v20.x, restore 00001-8md@100%, digest-execute c6f51425… → v22.23.1). Paste the rehearsal record path + PASS/FAIL lines here.>> |
| Staging deploy log id | **N/A, disclosed:** `public.staging_deploy_log` does not exist in the replayed chain (verified empty `information_schema` readback on this rig at stand-up), and this deploy was the manual isolated-rig pattern (digest-pinned `gcloud run deploy`), not `scripts/staging/deploy.sh` (hard-scoped to shared staging). The deploy artifacts are the digest chain + revision record above. If the gate hard-requires a row id, that is a gate-format conversation, not missing soak reality |
| Migration applied | N/A — #2291 touches no `supabase/migrations/` file (runtime-only change; rig schema replay is environment provisioning, not PR-owned migration) |

## What this window covers for #2291 — and what it does NOT

**Covers:** the Node 22 runtime serving Arkova's actual worker surface for 12 h at the
frozen head — HTTP stack, undici outbound HTTPS to Supabase with keep-alive, zlib, crypto
(HMAC api-key reject), in-process cron, switchboard flag reads, both verify projection
shapes, declared 404/401 semantics, health — on an isolated `clean_mirror` DB at ledger
head `0414`, with per-probe predicates and a dedicated 429 counter.

**Does NOT cover — do not cite this window for any of these:**

- **Prod-shaped load.** Offered load is ~19 req/min, single IP, serial probes. No
  concurrency bursts, no multi-instance fan-out, no rate-limiter saturation. Prod traffic
  shape (and the 2026-08 fullsoak's 8-way-concurrent anchor bursts) is out of scope.
- **Multi-org behavior.** Single-org rig (`org_topology: 1 org`). Per-org isolation,
  cross-tenant queue fairness, and org-fan-out under Node 22 are not exercised.
- **Anchoring / chain / treasury on Node 22.** `ENABLE_PROD_NETWORK_ANCHORING=false`, no
  WIF mounted, `kms: warning`. bitcoinjs-lib signing, GetBlock broadcast, and
  mempool.space fee/UTXO paths never execute in this window. (Not owed at T2 for this PR;
  stated so nobody upgrades this record into chain evidence.)
- **Batch triggers / anchor lifecycle.** No Trigger A/B/C/D machinery — T3 surface, not
  declared, not exercised.
- **Memory pressure / long-horizon leak behavior.** 1 Gi instance, 12 h horizon, no
  pressure test. A Node 22 heap regression that needs days or load to surface is not
  ruled out by this record.
- **Connector-sourced document paths** (DocuSign/Drive server-side fingerprinting) — not
  probed.
- **The dependabot backlog #2291 unblocks** (e.g. #2264 `@google-cloud/kms` 6.x). Each of
  those lands on its own evidence; this window proves the floor they need, nothing more.

## Teardown checklist — ONLY after the evidence block is applied to #2291 AND the PR is readied

> Order matters: evidence block pasted into #2291 and verified by the gate first, PR
> readied per process second, teardown last. A torn-down rig cannot re-answer questions.
> All four steps below, then the HANDOFF `### Soaks` block loses this entry.

1. **Delete the Supabase project** (paid project — MCP `pause_project` cannot pause it;
   deletion is the sweep-approved end state for a finished isolated rig, §7):

   ```
   # Management API (needs SUPABASE_ACCESS_TOKEN in env):
   curl -sS -X DELETE -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
     https://api.supabase.com/v1/projects/yklabujmzhzbvnhovcjt
   ```

   If the token is not at hand, flag for Carson to delete `arkova-node22-2026-08`
   (org `byhkazrpmivhcsuqjtva`) from the dashboard — do not leave it billing at $10/mo.

2. **Delete the Cloud Run service** (removes revisions `00001-8md` and the rehearsal's
   `rollback-node20` revision together):

   ```
   gcloud run services delete arkova-worker-node22-staging \
     --project arkova1 --region us-central1 --quiet
   ```

3. **Delete the three GSM secrets** (names verified against `gcloud secrets list` on
   2026-08-23; exactly these three match `*-node22-2026-08-staging`):

   ```
   gcloud secrets delete ip-hash-pepper-node22-2026-08-staging          --project arkova1 --quiet
   gcloud secrets delete supabase-service-role-key-node22-2026-08-staging --project arkova1 --quiet
   gcloud secrets delete supabase-url-node22-2026-08-staging            --project arkova1 --quiet
   ```

4. **Flip the rig reservation to released** — edit
   `docs/staging/rig-reservations.json`: reservation `resv-PR2291-NODE22-0001` →
   `"status": "released"`, then validate:

   ```
   npx tsx scripts/staging/check-rig-reservations.ts docs/staging/rig-reservations.json
   ```

   (The active row lives on THIS branch — commit 923809c33; it is not on `main` until
   this branch merges. Flip it here, not on `main`.)

5. **Local driver hygiene:** supervisor exits on its own at end-epoch; confirm
   `pgrep -f node22-load-loop` is empty, then archive `~/arkova-soak/node22/` contents
   into the close-out dir (close-capture already copies `load-*.json` +
   `supervisor.log`). Delete the key material (`anon.key`, `sr.key`, `cron.secret`,
   `idtoken`) — the project they open no longer exists after step 1.
