# Evidence E8 — preflight is `fixture_seeded`, not `clean_mirror`: residual-risk note

**Captured 2026-09-01T20:34:30Z**, ~8 h before the RC-3 window closes — deliberately run
early so a failure could not surface for the first time at seal time.
Artifact: `preflight/clean-mirror-preflight-docusign-bilateral.json` (raw, unedited).

## Result
`environment_type = fixture_seeded` (exit 1). §1.11A: only `clean_mirror` is merge-grade,
so **this rig's evidence is not merge-grade by the letter of the rule.** Stating that plainly
before arguing anything else.

| Check | Result | Detail |
|---|---|---|
| staging_only_rows | PASS | No PR-only or staging-only migration rows |
| duplicate_names | PASS | None |
| duplicate_versions | PASS | None |
| known_artifacts | PASS | No `soak_artifact` rows |
| **submitted_anchors** | **FAIL** | "Zero SUBMITTED anchors — environment may lack test fixtures" |
| **prod_divergence** | **FAIL** | Unexplained extras: `0418, 0419, 0423, 0424` |
| org_topology | PASS | 3 orgs, no staging seed orgs, prod-like single-tenant shape |

## Root cause — a process error, not contamination
The sanctioned order is: provision → run preflight (`clean_mirror`) → apply the feature
migrations → soak. This rig was provisioned **manually via the Supabase MCP** rather than
through `scripts/staging/provision-isolated-rig.sh`, so step 2 was skipped and the feature
migrations were applied first. A `clean_mirror` reading is therefore no longer obtainable
retroactively for this window. The sibling `mig-docusign-trust` soak did it correctly and
captured `clean_mirror` before any load — that is the standard this window did not meet.

## Why the two failures are not contamination
**`submitted_anchors`.** This check exists (per `seed-baseline-fixture.sql`'s own header) to
catch a HOLLOW soak — a rig whose worker is healthy but which exercises nothing. It fails
here for the opposite reason: **every anchor progressed past SUBMITTED to SECURED.** At the
time of capture the rig held 105+ anchors, all `SECURED` with chain tx ids, 0 `PENDING`, and
all connector artifacts in terminal `anchored`. The check's *purpose* is satisfied by far
stronger evidence than the single SUBMITTED fixture row it looks for: 158 cycles, 946 probes,
153 anchor confirmations, and a demonstrated full lifecycle (E4, E6). The failure is a
fixture-shape assertion defeated by the pipeline working, not by the pipeline being idle.

**`prod_divergence`.** All four "unexplained extras" are explained:
- `0418`, `0419` — the documented prod-ahead-of-main pair (present in prod's ledger, absent
  from `main`, owned by open PRs #2336/#2355). Recorded in `supabase/migrations/agents.md`.
- `0423`, `0424` — **the migrations under test.** Any rig soaking an unmerged migration will
  show it as an extra; this is inherent to migration soaking, not a property of this rig.

`missing_from_staging` is empty — the rig lacks nothing prod has.

## Disposition
Recorded as an explicit **residual-risk note** under §1.11A rather than claimed as
`clean_mirror`, and carried into the RC manifest as a deviation. The honest summary: the
substantive integrity checks (no PR-only rows, no duplicate names/versions, no artifact rows,
prod-like topology, nothing missing vs prod) all PASS; the two failures are a fixture-shape
check inverted by success and the expected presence of the migrations being tested.

**This does not entitle the evidence to be treated as `clean_mirror`.** It is a documented
exception for a human to accept or reject. If rejected, the remedy is a rebuild in the
correct order (preflight first) plus a fresh 48 h window — roughly two days.

## Correction for future soaks
Provision through `scripts/staging/provision-isolated-rig.sh`, which runs the preflight and
**requires `clean_mirror` before returning**, instead of hand-provisioning via MCP. Manual
provisioning skips the one gate that makes the resulting evidence merge-grade.
