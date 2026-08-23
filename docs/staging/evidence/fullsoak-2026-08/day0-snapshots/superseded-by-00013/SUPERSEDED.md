# Superseded by rig revision `00013-mrw` — 2026-08-12

Everything in this folder describes the **`arkova-worker-fullsoak-2026-08-staging-00012-f45` era**
of the 2026-08 full-functionality soak rig. It is retained, not deleted: these files are what the
00012-era daily report was compared against, and removing them would orphan that report.

## What changed

One **authorized freeze-break deploy** replaced `00012-f45` with `00013-mrw`
(Ready ~2026-08-12T15:10:20Z).

| | `00012-f45` | `00013-mrw` |
|---|---|---|
| Image digest | `sha256:8ace89d4…` | `sha256:8ace89d4…` — **unchanged** |
| `git_sha` | `f5d1070f…` | `f5d1070f…` — **unchanged** |
| `BITCOIN_UTXO_PROVIDER` | `mempool` | `getblock` |
| VPC access | none | connector `fullsoak-btc-rpc`, egress `private-ranges-only` |
| Traffic | pinned revision name | `latestRevision: true` at 100% |
| `/health.uptime` | ran to 1510 s | reset to 0 at the deploy |

The redeploy resets the soak clock. It happened **before** the clock start, which is the only
point at which it is affordable (premortem §6.3 step 3: nothing may deploy after the final revision).

## Verified, not assumed

`REGENERATION-DIFF.md` in this folder is the machine-generated comparison of every Day-0 surface
across the two eras. Result: `scheduler-census.txt`, `switchboard-flags-material.txt`,
`switchboard-flags-full.tsv` and `monitoring-census.txt` are **byte-identical**; only
`rig-env-dump.txt` changed, and its diff is exactly the three lines above (one env value, two
annotations) with nothing else moving.

## Contents

| Path | What it is |
|---|---|
| `day0/` | The 00012-era Day-0 baseline set (env dump, flags, scheduler, monitoring, uptime, build, hashes, README). |
| `daily-2026-08-12-00012-era/` | The 00012-era daily check run and its raw artifacts — verdict `DAILY_PARITY: PASS`, 20 PASS / 0 FAIL / 0 SKIP. |
| `REGENERATION-DIFF.md` | Old-vs-new comparison of every baseline surface. |

## What supersedes it

`docs/staging/evidence/fullsoak-2026-08/day0-snapshots/` — the `00013-mrw` baselines, which add
`detailed-health-baseline.json` (seeds the A16c `lastSecuredAt` advancement check) and
`rpc-node-baseline.json` (bitcoind VM liveness, now on the soak's critical path via the VPC connector).
