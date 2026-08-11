# Gate 0 evidence — 7-day full-functionality soak (2026-08)

Artifacts backing the Day-0 gate in [`../../PRE-SOAK-CHECKLIST-AND-PREMORTEM.md`](../../PRE-SOAK-CHECKLIST-AND-PREMORTEM.md).

## Provenance (CLAUDE.md §1.11A / checklist V5)

| Field | Value |
|---|---|
| Rig Supabase project ref | `gnkuaywlpmsaezwvlvhk` (`arkova-fullsoak-2026-08`) |
| Cloud Run service | `arkova-worker-fullsoak-2026-08-staging`, `arkova1`, `us-central1` |
| Revision at capture | `arkova-worker-fullsoak-2026-08-staging-00007-rzs` |
| Image digest | `sha256:a5231f21aef77c05b6ce0b9cda306bcacea8a2d2e72f09da5369bbb50612764f` |
| Image git SHA | `2de4e4e344f3749a09c52d7411831b7d2735528c` (identical to prod) |
| Bitcoin network | `signet` |
| Captured | 2026-08-11 UTC |

Production (`vzwyaatejekddvltxyye`) was read **read-only** for comparison only.

---

## `anchor-baseline-frozen.csv` — B2

Every anchor present on the rig **before** the soak clock starts, captured
2026-08-11T17:1xZ, immediately prior to deletion of the fabricated rows.

`fixture_seeded=true` marks rows carrying deterministic seed UUIDs
(`aaaaaaaa-…` / `cccccccc-…`) written by `supabase/seed.sql`. All 11 carry
invented `chain_tx_id` values or none at all. The single `fixture_seeded=false`
row (`4bd6cc01-…`) was created through the public API during rig provisioning
and is genuine.

**`valid_txid_format` is necessary but NOT sufficient to detect fabrication.**
Two fabricated rows — `cccccccc-…0001` and `cccccccc-…0002` — are 64 characters
of valid lowercase hex and therefore **pass** `^[0-9a-f]{64}$` while being
entirely synthetic. Any soak assertion relying on that regex alone to exclude
the baseline would have silently readmitted them. This is why the fabricated
rows were **deleted** rather than excluded by predicate.

## `flag-runtime-snapshot-BEFORE-*.json` — B3

Raw Cloud Logging entry of the worker's own `Feature flag registry initialized`
startup log: the resolved value **and source** (`env` / `db`) of all 47 flags as
the running process computed them. This is the runtime resolver's output, not a
`select` on `switchboard_flags`.

It establishes the pre-change baseline and documents that the dark soak-critical
flags are dark because of **absent Cloud Run environment variables**, not absent
`switchboard_flags` rows.
