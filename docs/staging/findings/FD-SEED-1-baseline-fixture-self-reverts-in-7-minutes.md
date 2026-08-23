# FD-SEED-1 — the baseline soak fixture deletes itself within ~7 minutes on every rig that uses it

> **FIXED in `scripts/staging/seed-baseline-fixture.sql` (PR #2322).** Rigs provisioned
> before that PR are repaired by re-running the seed — see [Status](#status). The finding
> below is preserved as written.

**Found:** 2026-08-21, on the TRAIN-6 T3 window (`arkova-worker-wave2-2026-08-staging`, tag
`train-6`, Supabase `tkciooifwxwnkoizgalp`). It voided that window's first 48 h clock.
**Class:** evidence integrity — and it is **systemic, not rig-specific**. Every isolated soak
rig provisioned with `scripts/staging/seed-baseline-fixture.sql` has this defect.

## The finding

`scripts/staging/seed-baseline-fixture.sql` exists for exactly one reason: preflight Check 5
(`submitted_anchors`) requires at least one `status='SUBMITTED'` anchor, and an isolated rig
is provisioned with no data. The seed inserts one SUBMITTED anchor.

It inserts it with **`chain_tx_id` NULL**.

That is precisely the row shape migration `0379_f3_recover_submitted_null_txid.sql` was
written to *destroy*. `public.recover_stuck_broadcasts()`:

```sql
WHERE a2.status IN ('BROADCASTING', 'SUBMITTED')
  AND a2.updated_at < now() - (p_stale_minutes || ' minutes')::interval   -- default 5
  AND a2.deleted_at IS NULL
  AND a2.chain_tx_id IS NULL
  AND NOT EXISTS (... anchor_txid_journal PENDING/HELD ...)
```

…resets the row to `PENDING`. `routes/scheduled.ts` schedules
`recover-stuck-broadcasts` in-process on `*/2 * * * *`, in **all** environments.

So the timeline on any freshly-seeded rig is fixed:

| t | event |
|---|---|
| T+0 | seed writes the SUBMITTED anchor, `chain_tx_id` NULL |
| T+5 min | the row crosses `recover_stuck_broadcasts`' staleness threshold |
| T+5..7 min | the next 2-minute cron tick resets it to `PENDING` |
| T+7 min | `submitted_anchors` reads **zero**; preflight returns `fixture_seeded`, exit 1 |

A soak started on a rig whose preflight passed at provisioning is therefore **not** running on
a clean environment seven minutes later, and nothing in the pipeline notices.

## Proof, on the row itself

TRAIN-6's fixture anchor, read at 2026-08-21T20:14Z:

```
id         5eed0000-0000-0000-0000-0000000000c1
public_id  ARK-DOC-E5NTRD
status     PENDING
updated_at 2026-08-21 19:00:19.155804+00
metadata   { "_recovery_reason": "stuck_submitted_null_txid",
             "_recovered_from_status": "SUBMITTED",
             "_recovered_at": "2026-08-21 19:00:19.155804+00",
             "_previous_claimed_by": "unknown" }
```

`_recovery_reason = 'stuck_submitted_null_txid'` is a string that exists in exactly one place
in the codebase: the SUBMITTED branch `0379` added to `recover_stuck_broadcasts()`. The
reclaimer is named by the row it reclaimed.

## The wrong attribution this replaces

(Also recorded independently as [`FD-TRAIN6-1`](FD-TRAIN6-1-soak-driver-invalidates-its-own-preflight.md)
/ SCRUM-3189, filed by a parallel session on the same symptom. That finding's general rule is
sound; its causal attribution is the one corrected here, and a banner at the top of that file
points back to this one.)

TRAIN-6's stand-up doc concluded the reclaimer was the soak's own load driver — specifically
its `2249-anchor-expiry-sweep` probe — and therefore that "this window can never reach a
passing preflight while its driver runs."

That is not correct, and the distinction matters because it points at the wrong fix.
`jobs/anchorExpirySweep.ts` selects **only** `status = 'SECURED'`:

```ts
.eq('status', 'SECURED').is('deleted_at', null)
.not('expires_at', 'is', null).lt('expires_at', nowIso)
```

and transitions those to `EXPIRED`. It has no code path that reads, writes, or even sees a
`SUBMITTED` row. Stopping, retargeting, or deleting the probe would have changed nothing:
the reclaimer is a DB cron the driver does not control.

**Lesson:** when a row changes underneath a soak, read the row's own provenance before
blaming the thing you happen to be running. `anchors.metadata` carries `_recovery_reason` /
`_recovered_from_status` for exactly this purpose.

## The fixture that actually survives

Two independent exclusions, both required, because two different jobs mutate SUBMITTED rows:

| Mutator | Cadence | Predicate | Exclusion used |
|---|---|---|---|
| `recover_stuck_broadcasts()` (0379) | `*/2` in-process | `chain_tx_id IS NULL` | **`chain_tx_id` NOT NULL** |
| `autoConfirmMockAnchors()` (`USE_MOCKS=true` rigs) | `*/2` in-process | `legal_hold = false` | **`legal_hold = true`** |
| `monitorStuckTransactions()` | `*/10` | `useMocks` early-return **and** `legal_hold = false` | both |
| `rebroadcastDroppedTransactions()` | `0 */6` | `useMocks` early-return **and** `legal_hold = false` | both |

`legal_hold = true` alone is **not** enough — `0379` deliberately does not check `legal_hold`
(its own header explains why: recovery-to-PENDING is not a delete/revoke/supersede). The
current seed sets `legal_hold = true` and stops there, which is why it survives
`autoConfirmMockAnchors` and dies to `recover_stuck_broadcasts`.

`chain_tx_id` NOT NULL is also the **more correct** shape on its own merits:
`machines/bitcoinAnchor.machine.ts` invariant INV-1b (`submittedRequiresChainTx`) says a
SUBMITTED anchor with a null txid is unreachable through every modeled write path. The seed
was manufacturing a state the state machine says cannot exist, and `0379` is the self-healing
net that cleans it up. The seed was fighting a guard that was doing its job.

Use a synthetic 64-hex txid that does not exist on-chain: `checkSubmittedConfirmations`'
real-mode path fetches it, gets a 404, and returns without promoting — so the row is durable
on both mock and real rigs.

## Status

- **TRAIN-6:** fixed in-place for that rig by seeding a durable Set A (5 SUBMITTED anchors,
  `chain_tx_id` NOT NULL + `legal_hold = true`) before restarting the clock. Durability
  measured, not asserted — see `docs/staging/train6-2026-08/soak-start-2026-08-21T2038Z.md`.
- **`scripts/staging/seed-baseline-fixture.sql`: FIXED (PR #2322).** The fixture anchor now
  carries a synthetic 64-hex `chain_tx_id` — `md5('…-txid-hi') || md5('…-txid-lo')`,
  deterministic so re-runs stay idempotent — alongside the `legal_hold = true` it already had.
  Three things landed with it:
  - **The repair path.** `ON CONFLICT (id) DO UPDATE` backfills a NULL `chain_tx_id` and
    reinstates a fixture that `0379` already reclaimed to PENDING, so **re-running the seed
    fixes a rig provisioned before this change** — no teardown needed. It reinstates the
    status only when the row is PENDING *and* holds no txid of its own, so a row carrying a
    real txid keeps its own status; the clause never invents a submission that did not happen.
  - **An in-transaction post-condition block** (`DO $$ … $$` before `COMMIT`) that fails the
    seed if the fixture is absent, not SUBMITTED, missing a `chain_tx_id`, off legal hold, or
    if `ENABLE_VERIFICATION_API` is not enabled. `provision-isolated-rig.sh` runs the seed
    through `run_cmd` under `set -euo pipefail`, so a `RAISE` there aborts provisioning
    **before** the clean_mirror preflight can certify a rig whose fixture is already doomed.
    This proves the structural predicate rather than waiting out a cron tick — a row outside
    every mutator's WHERE clause *cannot* be taken, which is strictly stronger than observing
    that one tick happened not to take it. No shell-side change was needed.
  - **Structural tests** in `scripts/staging/seed-baseline-fixture.test.ts` pinning the txid,
    both halves of the repair clause, and the presence of the post-condition block.

  Verified by execution, not by reading the diff: the file was run against a throwaway
  Postgres 17 carrying stub `auth`/`public` tables and a verbatim copy of `0379`'s
  `recover_stuck_broadcasts()` predicate. Backdated 60 minutes and ticked three times, the
  reclaimer took **0** rows and the fixture stayed SUBMITTED. Reverting that same row to the
  pre-fix shape (`chain_tx_id` NULL) and ticking once reproduced the finding exactly —
  1 reclaimed, `_recovery_reason = 'stuck_submitted_null_txid'`, Check 5 down to zero — and
  re-running the fixed seed restored it to SUBMITTED and durable.
- **Preflight:** `staging-honesty-preflight.ts` reports Check 5 as a point-in-time count. It
  cannot distinguish "no fixture" from "fixture that will evaporate in five minutes." The
  TRAIN-6 driver now re-measures the SUBMITTED count every member pass and records it in each
  evidence file (`fixture.submitted` vs `fixture.submittedFloor`), which turns a one-shot
  preflight assertion into a continuously-audited invariant.
