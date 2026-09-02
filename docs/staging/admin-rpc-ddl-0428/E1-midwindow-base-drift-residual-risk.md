# Evidence E1 — mid-window base drift (migration 0417): residual-risk note

**Captured 2026-09-02T14:48:53Z**, at roughly T+16 h of a 48 h T3 window.
Artifact: `clean-mirror-preflight.json` (raw, unedited — the post-remediation run).

Written in the shape of `docs/staging/docusign-bilateral-2026-08/evidence/E8-preflight-residual-risk.md`,
which is the house precedent for a preflight deviation.

## What happened

The rig was provisioned through `scripts/staging/provision-isolated-rig.sh` and read
`environment_type = clean_mirror` at T0 (2026-09-01T22:50:19Z), against the repo tree as it
stood then. During the window `main` advanced — among other things PR #2335 merged, landing
`supabase/migrations/0417_cleanup_expired_data_singleton_advisory_lock.sql`.

When `main` was merged into this PR's branch (required: the PR had gone `DIRTY` on
`HANDOFF.md`), the repo tree gained `0417` while the rig did not have it. Re-running the
preflight at that point returned:

| Check | Result | Detail |
|---|---|---|
| staging_only_rows | PASS | No PR-only or staging-only migration rows |
| duplicate_names | PASS | None |
| duplicate_versions | PASS | None |
| known_artifacts | PASS | No `soak_artifact` rows |
| submitted_anchors | PASS | 1 SUBMITTED anchor |
| **prod_divergence** | **FAIL** | `Repo migrations missing from rig: [0417]` |
| org_topology | PASS | 2 orgs, no staging seed orgs, prod-like single-tenant shape |

`environment_type = soak_artifact`. One failing check, one cause.

## Remediation

`0417` was applied to this rig (and only this rig) at 2026-09-02T14:47Z, with its numeric
ledger row recorded in the same motion. The preflight then returned **`clean_mirror`** at
2026-09-02T14:48:53Z, with every check passing.

The soaked surface was re-verified immediately afterwards and is unchanged:

    admin_change_user_role   contains ALTER TABLE : false
    admin_set_platform_admin contains ALTER TABLE : false
    admin_set_user_org       contains ALTER TABLE : false
    check_role_immutability  has the flag guard   : true
    triggers on profiles not enabled              : 0

## The residual risk, stated plainly

**The rig's schema changed at T+16 h of a 48 h window.** The environment is therefore not
byte-identical across the whole window: cycles 1..~63 ran without `0417`, later cycles run
with it. By the letter of §1.11A the strongest claim available is "clean_mirror at T0 and
clean_mirror from T+16 h onward", not "clean_mirror continuously".

## Why this is argued to be immaterial — and where that argument stops

`0417` is disjoint from everything 0428 touches:

- it redefines `cleanup_expired_data()` and the `reject_audit_delete` /
  `reject_audit_modification` triggers on `audit_events`;
- it contains **zero** references to `profiles` (grep-verified, count 0);
- it touches none of `admin_change_user_role`, `admin_set_platform_admin`,
  `admin_set_user_org`, `check_role_immutability`, `protect_platform_admin_flag`, or
  `protect_privileged_profile_fields`.

Every driver assertion is about `profiles` and those six routines. `0417` cannot influence
any of them, and the post-apply verification above confirms none of them moved.

Cycle results are green on both sides of the change: **0 failures across the whole window to
date**, including the two assertions that would detect a widened exemption (C4, the worker
backfill regression guard) and the one that would detect a returned lock barrier (C11).

**Where the argument stops:** this reasoning is about *disjointness*, not about having
soaked the merged tree for a full 48 h. A reviewer who requires the entire window on one
unchanged schema should reject this note. The remedy is a clock restart — roughly 16 h of
elapsed evidence discarded and a fresh 48 h window, closing about 2026-09-04T15:00Z instead
of 2026-09-03T22:49Z.

## Disposition

Recorded as an explicit **residual-risk note** under §1.11A. It does **not** entitle this
window to be treated as continuously `clean_mirror`. It is a documented exception for a
human to accept or reject.

## Note for future soaks

Base drift on a T3 is structural, not exceptional: `main` moves during any 48 h window, and
any merged migration will make a running rig read `soak_artifact` until it is applied. The
check that catches it (`prod_divergence`) compares the rig against the *repo tree*, so it
fires the moment the branch merges `main` — not when the rig degrades. Re-running the
preflight after every `main` merge, rather than only at seal time, is what turned this into
a 90-second fix instead of a discovery at seal.
