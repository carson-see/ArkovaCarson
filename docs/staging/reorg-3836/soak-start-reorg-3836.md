# T3 soak — SCRUM-3836 / PR #2495 — START

**Started:** 2026-08-30T22:46:17Z
**Tier:** T3 (migration + chain-safety code on the anchor lifecycle)

## Rig identity

| Field | Value |
|---|---|
| Isolated Supabase project | `hgmluvnqgfcigevqeebu` (arkova-soak-reorg-3836, us-east-2, PG 17.6) |
| Cloud Run service | `arkova-worker-reorg-3836-staging` |
| Cloud Run revision | `arkova-worker-reorg-3836-staging-00002-mt7` |
| Image digest | `sha256:521582bf2f392ffd575d69102860994ab8c900021b9a42f63cc3793514d1e6c9` |
| PR head SHA (source) | `adde508e7ad849c44e4fc766efcee5e6e70c35ac` |
| Scheduler job | `arkova-worker-reorg-3836-staging-detect-reorgs`, `*/10 * * * *`, NO_RETRY |
| Migration ledger head | 0425 (118 rows) |

## Why an isolated project, not the standing rig

`fizyjojbebyalirtjjht` (arkova-staging-2026-08) was evaluated first and its
honesty preflight returned **`environment_type: "soak_artifact"`**, not
`clean_mirror` — `prod_divergence` FAIL, repo migrations missing from the rig
(`0418`, `0419`, `0425`). Under §1.11A that makes it invalid for new
merge-grade evidence, so this soak uses its own project. That rig is also the
target of the shared `arkova-worker-staging` service, and this PR changes
migrations, so §1.11A would require exclusive use regardless.

## Fixture — the part that matters

The defect is **scale-dependent**: an unindexed scan that crosses
`statement_timeout`. A default rig fixture cannot exercise it. The soak rig was
seeded to **675,000 anchors / 1039 MB**, heights 700000–964739, plus 250 anchors
pinned into the live reorg window (tip-10).

Measured on THIS rig, same query, index on vs forced off:

| Plan | Time |
|---|---|
| `Index Scan using idx_anchors_reorg_scan` (0425 applied) | **1.4 ms** |
| Forced `Seq Scan` (the pre-0425 plan) | **953.3 ms** |

~680x. **Honest limit:** at 675k/1 GB the seq scan is ~1 s, so the rig does NOT
itself reach the 60 s `statement_timeout` that prod hit at 3.8M rows / 23 GB.
The rig proves the plan flip and its magnitude; the prod measurement
(`pg_stat_statements`: 1,108 calls, mean 11,426 ms, max 59,986 ms) covers the
timeout itself. Neither alone is sufficient; together they are.

## Changed behavior confirmed live on the rig

- `/jobs/detect-reorgs` → **HTTP 200**, and the new `info` log fires:
  `Reorg detection complete — no candidate anchors in window` (empty-window branch,
  `completed: true`). Before this PR that branch was **silent**.
- With in-window anchors: **`checked: 20, reorgsDetected: 20`** in 7.9 s.
  The scan now inspects anchors; pre-fix it returned `checked: 0` on every run.
- **Note on the 20 "reorgs":** the fixture's `chain_tx_id` values are synthetic
  md5 strings that do not exist on mainnet, so mempool.space 404s and the detector
  correctly reverts SECURED → SUBMITTED. This is the revert path working, NOT a real
  chain event. Do not read it as a mainnet reorg.

## Safety posture

`ENABLE_PROD_NETWORK_ANCHORING=false`, no treasury/KMS secret mounted, and no
`batch-anchors` scheduler job wired — the rig is **incapable of broadcasting or
spending**. `--profile chain` from `provision-isolated-rig.sh` was deliberately
NOT used: it mounts `bitcoin-treasury-wif-staging` and resumes `batch-anchors`
live, which is disproportionate for a read-only reorg-detection soak. (Those three
chain secrets do not exist in Secret Manager anyway.)

`DISABLE_IN_PROCESS_ANCHOR_CRON=true` so the in-process duplicate (SCRUM-3191,
a separate open defect) cannot contaminate the scheduler-path evidence.

## Still to gather

48 h uptime, multiple trigger cycles, the 503 path under an induced query failure,
rollback rehearsal, per-org isolation. This file records the START only.

---

## Update 2026-08-30T23:55Z — both detector branches proven, zero false positives

The initial 250-anchor window used synthetic `chain_tx_id`s only, so it exercised
just the revert path and would have drained in ~4 runs, leaving ~47 h of
empty-window no-ops. Topped up with a discriminating fixture:

- **40 anchors carrying REAL mainnet txids** (pulled live from block `tip-3`),
  at the real height — the detector must find these confirmed and leave them alone.
- **6,000 synthetic anchors** at `tip..tip+40`. Because the filter is
  `chain_block_height >= tip-10`, these stay in-window as the tip advances, so the
  scan keeps doing real work for the whole 48 h (20 txids/run × 6 runs/h × 48 h
  ≈ 5,760 consumed).

After three further runs:

| Fixture | Status | Reading |
|---|---|---|
| `soak-real-%` (real mainnet txids) | **40 SECURED, 0 reverted** | No false positives — confirmed txs are correctly left alone |
| `soak-pool-%` (synthetic txids) | 60 SUBMITTED, 5,940 SECURED | Revert path works and **persists**; draining ~20/run as designed |

This is the discriminating result: the detector separates genuinely-confirmed
anchors from missing ones, and **does not revert a real confirmed anchor**. A
fixture of synthetic txids alone could not have shown that — it would revert
everything and look identical to a broken detector that reverts unconditionally.

Steady state: 8+ consecutive scheduler fires, all HTTP 200, ~5 s each, on the
`*/10` schedule; revision `…-00002-mt7` Ready.

**Earlier reverts:** the original 250-anchor window ended 167 SUBMITTED / 83
SECURED before top-up. Those were synthetic and are expected reverts, not chain
events.
