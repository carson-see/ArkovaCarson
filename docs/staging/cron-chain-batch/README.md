# cron-chain-batch — isolated T3 soak stand-up (PRs #2429, #2438, #2495)

Internal engineering notes. Confluence is the source of truth for documentation
(CLAUDE.md §0 rule 4); this file records how the rig was stood up and what the
soak actually measured, so a reviewer can re-verify rather than take it on trust.

## Why one rig for three PRs

All three PRs rewrite `services/worker/src/routes/cron.ts`; #2495 and #2429 both
rewrite `jobs/chain-maintenance.ts`; #2495 and #2438 both rewrite
`jobs/batch-anchor.ts`. Soaked apart, each PR's evidence is invalidated by the
others on merge, and they collectively define the rig's cron side effects — so
one rig running the merged stack is the only honest configuration (CLAUDE.md
§1.11A: evidence may not be copied across heads).

Integration head (soak head): `c6874e0108a516f3741718cf25a98ad4a10422f6`
built by merging, in PR-number order, onto `origin/main` `dca9edb401a98f05fee7447dfe068773c6705fbb`:

| PR | head merged | conflicts |
|---|---|---|
| #2429 | `564f287bf6d23a5e54ef749e0f578b0ed6026947` | none |
| #2438 | `064c0b443d326284e0a052da5012c3835e3a66ba` | none |
| #2495 | `adde508e7ad849c44e4fc766efcee5e6e70c35ac` | auto-merged `routes/cron.ts` |

> **Head drift, recorded:** the batch was handed to this session with #2495 at
> `3b1e55cbc0e2dffa9a59436ed84fcc01fcabc014`. That commit is an **ancestor** of
> the PR's live head `adde508e7…` (verified with `git merge-base --is-ancestor`).
> The soak binds to the live head, not the stale one.

## Rig

| Field | Value |
|---|---|
| Supabase project | `arkova-soak-cron-chain-batch` |
| Project ref | `sdkcfqprpmacxlazwjdy` (us-east-2, PG 17.6.1.166) |
| Cloud Run service | `arkova-worker-cron-chain-batch-staging` (us-central1) |
| Service URL | https://arkova-worker-cron-chain-batch-staging-270018525501.us-central1.run.app |
| Serving revision | `arkova-worker-cron-chain-batch-staging-00001-bxt` |
| Image digest | `sha256:a3deb4608bd84512c791e67fe2b314e1fd78e59d3628423e8951a7eb602d3ea8` |
| Scaling | `minInstances=2 / maxInstances=4`, `cpu-throttling=true` (prod's shape) |
| Network | `BITCOIN_NETWORK=signet`, `USE_MOCKS=false` |
| Ledger head | `0425` (`anchors_reorg_scan_index`) |
| Preflight | `environment_type=clean_mirror`, exit 0, `2026-08-30T22:12:43Z` |
| Soak clock | `2026-08-30T22:09:30Z` → `2026-09-01T22:09:30Z` (revision `creationTimestamp`, FD-CLOCK-1) |

`minInstances=2` is not decoration: #2429's whole question is whether an unleased
in-process `node-cron` job double-fires across live instances. With `minInstances=0`
the question is unanswerable. `cpu-throttling` is left at Cloud Run's default
(`true`) precisely because that matches prod — the retracted dormancy claim is
about throttled instances, so testing it on an unthrottled rig would prove nothing.

## Provisioner: what worked, what did not

`scripts/staging/provision-isolated-rig.sh --dry-run` was read first, then run
with `--apply CONFIRM_PROVISION=cron-chain-batch CONFIRM_REAL_CONFIG=chain`.
It completed Step 1 (project create) and then **failed at Step 2**:

```
+ npx supabase db push --linked
IPv6 is not supported on your current network: dial tcp: lookup db.sdkcfqprpmacxlazwjdy.supabase.co: no such host
ERROR: provision failed; fail-closed cleanup completed with original_rc=1.
```

This is the known COMING_UP/IPv6 link race. The fail-closed path does **not**
delete the project (it pauses Scheduler jobs and writes a `blocked_after_project_create`
state file — preserved here as `isolated-rig-provision-cron-chain-batch.json`,
deliberately **not** rewritten to claim success). The remaining steps were
executed by hand, following the script's own printed plan:

| Defect | Symptom | Work-around applied here |
|---|---|---|
| (1) Step 2 COMING_UP/IPv6 race | `LegacyDbConfigIpv6Error` / NXDOMAIN on `db.<ref>` | waited for `ACTIVE_HEALTHY`, re-linked, `db push --linked --include-all --yes` |
| (2) `IP_HASH_PEPPER` absent from every overlay | `config.ts` `superRefine` fails closed → boot crash-loop | created `ip-hash-pepper-cron-chain-batch-staging` and bound it on the deploy |
| (3) hold schedule `0 0 31 2 *` | `INVALID_ARGUMENT: The provided schedule or timezone are invalid` (reproduced live) | leap-day-safe `0 0 29 2 *`, created then paused |
| (4) chain-profile secrets absent | `bitcoin-{rpc-url,rpc-auth,treasury-wif}-staging` do not exist in `arkova1` | pointed at the existing signet set `arkova-s33-rig-b1-bitcoin-core-signet-rpc-{url,auth}` + `arkova-s33-rig-b1-treasury-wif-signet` via `STAGING_*_SECRET` overrides |

Two further gaps not on the known list:

* **`0381` cannot go through `db push`.** It carries three `CREATE INDEX CONCURRENTLY`
  statements and dies with `SQLSTATE 25001` (pipeline). Set aside, pushed the rest,
  applied `0381` through the **session pooler** (`aws-0-us-east-2.pooler.supabase.com`,
  `postgres.<ref>`), then inserted its ledger row and restored the file. `0425` has a
  single `CONCURRENTLY` statement and pushed cleanly.
* **`pg_trgm` must live in `public`**, not `extensions` (the baseline squash hardcodes
  `public.gin_trgm_ops`). Bootstrapped before the push.

## What the soak actually exercises

A driver (`soak-driver.mjs.txt` in this directory) runs a 5-minute cycle for the
full 48 h window and appends one JSON record per cycle. Per cycle it:

1. reads `/health` (OIDC identity token) and asserts `git_sha` == the soak head;
2. re-points nine `SECURED` fixture anchors at **real signet transactions** from a
   settled block inside `tip-10`, because the reorg scan's candidate predicate is
   `chain_block_height >= tip - 10` and signet advances ~6 blocks/hour — a fixture
   pinned once would leave the window within two hours and every later
   `checked: 0` would be an artefact of the fixture, not of the code;
3. on odd cycles arms a **poison anchor**: a real, confirmed txid stored against a
   deliberately wrong `chain_block_hash`, so the same-height-reorg path fires;
4. `POST /jobs/detect-reorgs` and records HTTP status plus `checked` /
   `reorgsDetected` / `reverted` / `completed` / `reason`;
5. `POST /jobs/batch-anchors` and reads the `ENABLE_BATCH_ANCHORING` row, so the
   response can be paired with the flag value that was live when it ran;
6. `POST /jobs/check-credential-expiry`;
7. every sixth cycle, an org-scoped forced drain (`?force=true&org_id=<A>`) with
   per-org PENDING counts either side;
8. counts in-process `node-cron` executions from Cloud Run logs (see below);
9. fires 40 in-band requests across `/health` and `/api/health` with rotating
   `X-Forwarded-For`.

### #2429 — how double-fire is measured

`check-submitted-confirmations` is registered in-process on `*/2 * * * *` and is
**never** driven over HTTP by the driver, so every occurrence of its start log
line is attributable to `node-cron`. The probe counts occurrences per minute
bucket per Cloud Run `instanceId`. Two distinct instances appearing in the same
minute bucket is a double fire, measured — not asserted.

The retracted CPU-throttling dormancy claim is tested the only way it can be:
on a `cpu-throttling=true`, `minInstances=2` service under continuous request load,
which is prod's shape.

### #2495 — why a green 200 is not the evidence

The prod defect was HTTP 200 with `checked: 0`. So `200` alone proves nothing here;
the driver requires a **non-zero `checked`** against a non-empty candidate set, on
every cycle, with the `0425` index present, plus at least one cycle where the
poison anchor produces `reorgsDetected >= 1` and `reverted >= 1`.

### #2438 — why the flags start OFF

`ENABLE_BATCH_ANCHORING` and `ENABLE_EXPIRY_ALERTS` are seeded **false**, so the
worker boots with an OFF snapshot. The driver then flips the rows mid-soak and
re-probes after 70 s (> the 60 s `FLAG_REFRESH_TTL_MS`), capturing the serving
revision name either side of the flip. A behaviour change with an unchanged
revision name is the whole claim: the boot snapshot is no longer authoritative.

## Evidence files here

| File | What it is |
|---|---|
| `clean-mirror-preflight-cron-chain-batch.json` | `staging-honesty-preflight.ts` output, exit 0, before load |
| `rollback-rehearsal-0425.txt` | full `DROP INDEX CONCURRENTLY` → health/endpoint probe → `CREATE INDEX CONCURRENTLY` transcript |
| `static-gates-at-soak-head.txt` | the batch's own new CI gates run at the soak head |
| `soak-driver.mjs.txt` | the driver source, verbatim |
| `soak-cycles.jsonl` / `soak-summary.json` | per-cycle records and the rolling aggregate |
| `isolated-rig-provision-cron-chain-batch.json` | the provisioner's own (blocked) state file, unedited |

## Teardown owed

`scripts/staging/teardown-isolated-rig.sh` against `sdkcfqprpmacxlazwjdy` +
`arkova-worker-cron-chain-batch-staging` once all three PRs are merged or closed.
Per-rig secrets to remove with it: `supabase-url-cron-chain-batch-staging`,
`supabase-service-role-key-cron-chain-batch-staging`,
`ip-hash-pepper-cron-chain-batch-staging`,
`supabase-db-password-sdkcfqprpmacxlazwjdy`, and the three paused Scheduler jobs
`arkova-worker-cron-chain-batch-staging-{detect-reorgs,batch-anchors,check-credential-expiry}`.
Do **not** tear down while any of #2429/#2438/#2495 is still open — the rig ref is
named inside all three evidence blocks.

## Interim results (window still open)

Captured while the 48 h clock was still running; the driver keeps appending to
`soak-cycles.jsonl` and `soak-summary.json` until `2026-09-01T22:09:30Z`.
`soak-rollup-interim.json` is the aggregate at the moment this doc was committed.

| Claim | Measurement |
|---|---|
| worker is the soak head | 14/14 cycles `/health` 200, `git_sha == c6874e0108a516f3741718cf25a98ad4a10422f6` |
| in-band load | 560/560 HTTP 200, 0 non-2xx, 0 transport errors |
| #2495 non-empty reorg scan | 14/14 `detect-reorgs` HTTP 200, 14/14 `completed:true`, `checked` total 114 (min 3, max 9), **0 cycles with `checked:0`** |
| #2495 reorg revert path | 7 reorgs detected, 7 anchors reverted SECURED -> SUBMITTED |
| #2429 double-fire | 2 distinct `instanceId`s; 14 fire-minutes, 11 with 2 instances; `double_fire_rate` 0.786-0.909 |
| #2438 live flag flip | `skipped:true` -> job ran, 70 s after the row flip, on revision `…-00001-bxt` both sides, `redeploy_occurred: false`, uptime 4255 s continuous |
| #2438 batch gate | last "Batch anchoring disabled" log line 23:20:08Z; forced drain OFF claimed 0 of 12, ON claimed 12 of 12 |
| per-org isolation | org A 12 PENDING -> 0, org B 8 PENDING -> 8 |
| 0425 rollback + reapply | clean; endpoint 200 and `/health` healthy throughout |

## Two things a reviewer must not skim past

**#2495 was soaked twice, concurrently, by two sessions.** A different session
stood up `hgmluvnqgfcigevqeebu` / `arkova-worker-reorg-3836-staging` for the same
PR and wrote its own evidence block. Both blocks now sit on the PR. That is a
coordination failure worth naming rather than a second opinion to average — the
batch block is the one that describes #2495 in the configuration it will land in
(merged with #2429 and #2438, which rewrite the same three files).

**#2495's head moved mid-window**, from `adde508e7…` to `bd19eff36…`. The delta is
exactly one added file, `docs/staging/reorg-3836/soak-start-reorg-3836.md`, with
zero code, schema or workflow changes — so the soak still describes the runtime.
Any non-documentation commit on that branch voids this evidence and restarts the
clock.

## Soak finding — `detectReorgs` has no `catch`

`detectReorgs` is `try { … } finally { releaseLock }`. When the mempool tip fetch
is **aborted** by its own 10 s `AbortSignal` — as opposed to answering non-OK —
the `TimeoutError` propagates instead of returning
`{ completed: false, reason: 'tip_unavailable' }`. Observed 3 times in a 30-minute
window on this rig ("Reorg detection cron failed", `TimeoutError: The operation was
aborted due to timeout`).

This does **not** reintroduce the prod defect: over HTTP the route's `catch` turns
it into a 500, never a healthy 200. But the reason code the PR designed is bypassed
on what is, in practice, the most likely tip failure. Follow-up, not a merge blocker.
