# Release Queue Drain Operating Plan - 2026-06-08

## Purpose

This runbook defines the release-first operating mode after PR #1121 merged. The goal is to drain the blocked PR queue without weakening SOC 2 Type 2 evidence, invalidating soaks, or requiring engineering work to pause every time a PR needs staging time.

This is a time-boxed, risk-scoped change-management operating mode. It is not an emergency bypass. Every merged change still needs authorization, CI evidence, risk classification, traceability, staging or release-candidate evidence appropriate to risk, and production proof.

## Current State

### Drain mirror sync - 2026-06-13

The mirror working-tree sync is a documentation/control-plane sync across the
active Extreme checkout, the Extreme mirror worktree, and the Crucial mirror
worktree. It does not change production code, migrations, production evidence,
or queue state.

PR #1055 merged 2026-06-10T23:35:49Z at merge commit
`3f906c991988f9b2ed6e71e1a70b64020cebd2fb`.

Final A/B soaks completed 2026-06-13T14:12:58Z /
2026-06-13T14:12:59Z with `2880/2880` ok and zero failures in both lanes.

Merged drain PRs: #1047, #1101, #1100, #971, #1038, #1111, #1112, #1114, #1107, #1122.

Remaining strict order: none. Train A/B release drain is complete.

#1112 merged at `2026-06-13T20:12:01Z` as
`21d72078259918df13b0f573bb30861f4afae5fe`. #1114 merged at
`2026-06-13T20:53:34Z` as `b73a0545a20bab0fb9682b4e346031af2ca986ba`.
#1107 merged at `2026-06-13T21:38:31Z` as
`8e62198345932a8e9ff25c41421adf112e3af6a0`. #1122 merged at
`2026-06-13T22:26:18Z` as `e51087a7990b349c09adca97797718a87c173e06`
from head `6ca17b237b29f53a3f53fc9409e9ca2ef632c9e1` on that base.

Post-drain dependency-lane PR #1155 merged at `2026-06-13T23:16:37Z` as
`7220fb4b41f2b0bae5662bbdfea721d867f53638` after being refreshed from stale
base onto #1122's main commit, passing required checks, entering Mergify queue,
and direct-merging with exact-head guard when the queue remained pending past
the batch tick. #1158 remains blocked by failed `Staging Soak Evidence Gate` and
must not be requeued until fixed.

### Release queue unblocker #1141 - merged 2026-06-10

PR #1141 (`fix(release): unblock parallel soak lanes`) merged via Mergify at
2026-06-10T15:56:23Z. Merge commit:
`3f678e7cb7b6f0bcb954141c75094730b49ef45e`.

This makes impact-based base drift and isolated-lane visibility the active
operating rule:

- Exact PR head SHA movement still invalidates evidence.
- Base SHA movement does not automatically invalidate a soak.
- T0 docs/tests/CI/tooling-only drift may preserve evidence only with a
  non-placeholder `Base drift impact:` note that lists changed files, states no
  runtime/schema/migration/staging/soak/deploy/worker-image impact, and names
  the approver.
- Runtime, schema, migration, staging, deploy, soak-behavior, or worker-image
  drift fails closed and requires release-owner re-scope/retest.
- `scripts/staging/load-harness.ts` requires `STAGING_API_BASE` and refuses
  shared/main staging URLs or untagged Cloud Run hosts.
- `npm run staging:soak-lanes` is the read-only lane dashboard for active,
  idle, and blocked soak candidates.

Safe development posture after #1141:

- Normal feature development may resume in isolated branches/worktrees.
- Product/runtime/migration PRs still need isolated lane evidence appropriate to
  their risk tier.
- Do not mutate shared staging, Supabase data, deployments, Mergify, branch
  protection, required checks, or existing release PR evidence outside an
  approved lane.
- #1141 does not make any product PR merge-ready by itself.

SCRUM-2312 tracks adoption. Parent Epic: SCRUM-2313. Subtasks: SCRUM-2314
through SCRUM-2318, plus SCRUM-2319 for the host-validation review follow-up.
Non-secret lane-dashboard sample:
`/Volumes/Extreme/Arkova/release-evidence/pr-1141/scrum-2312-soak-lanes-20260610T155859Z.txt`.

Earlier captured dashboard sample before #1055 completion, 2026-06-10T15:59:01Z:

- Active lane: PR #1055, detached screen, cron `2495 ok / 0 fail`, status
  `200=2495`, final JSON missing as expected before the 48h completion gate.
- Idle non-blocked T3/soak candidates: #1114, #1112, #1111, #1107, #1101,
  #1100.
- Blocked candidate: #1087 with `do-not-merge`.

### Premortem - readiness source-of-truth failure modes

Assume it is two weeks later and this source of truth failed to drive a clean
PI or launch. The following are the failure modes this runbook is designed to
prevent.

| Failure mode | Trigger | Detection | Required mitigation | Owner |
| --- | --- | --- | --- | --- |
| PR #1141 is mistaken for launch readiness | #1141 merges and teams assume parallel lanes are safe by default | A lane lacks final JSON, exact SHA, image digest, rollback proof, or production proof | Treat #1141 as release-process tooling only; each lane still needs exact-head evidence and completion bundle | Tech Lead A + Architect |
| Base drift is misclassified as harmless | Runtime/schema/migration/staging/deploy drift is labeled T0 docs/tests/CI/tooling-only | `Base drift impact:` lacks old/new base SHA, changed files, fail-closed category check, or named approver | Require explicit base-drift evidence; runtime/schema/migration/staging/deploy/worker-image drift always re-scopes/retests | Tech Lead A + Architect |
| Wrong evidence layer is accepted | Merge is treated as production, production-contained as Done Done, stored secret as runtime-safe use, dashboard visibility as completed soak, or live endpoint as partner-ready output | Jira Done while subtasks remain open; no route evidence, UAT, cron smoke, final soak JSON, no-secret smoke, or partner validation | Keep states separate: merged, production-contained, prod-verified, Done Done; block closeout without matching evidence | PM + Architect + Tech Leads |
| PR #1141 host-validation review issue is not resolved | Load harness accepts a host shaped like `pr-<number>---...` that is not an approved Cloud Run Arkova worker tag URL | Unresolved review thread or no test proving Cloud Run host constraints | Block #1141 as a readiness enabler until host validation is fixed or formally dispositioned | Tech Lead A + Architect |

Before starting or approving a soak, run `npm run staging:soak-lanes`. It is a
read-only lane dashboard that lists active `screen` soak sessions, latest local
soak summaries, missing final JSON, and idle open PRs whose titles still look
like T3, migration, or soak-pending candidates.

- Checked at: 2026-06-08T19:46:40Z.
- Repository: `carson-see/ArkovaCarson`.
- Live `main` SHA: `35023952a7657966c95e029ca480d38195507a14`.
- PR #1121 merged at: 2026-06-08T18:57:19Z.
- PR #1121 merge commit: `35023952a7657966c95e029ca480d38195507a14`.
- PR #1121 head SHA: `7918753029aa9b8d761930e520695e44f29bc9af`.
- PR #1121 pre-merge base SHA: `bf40e389fd1644aea94557366e367b7b66df7616`.

## Live Status Update - 2026-06-08T19:34Z

- Worker production deploy for `35023952a7657966c95e029ca480d38195507a14` completed successfully.
- Production `/health` returned `status=healthy` and `git_sha=35023952a7657966c95e029ca480d38195507a14`.
- Main CI completed successfully for `35023952a7657966c95e029ca480d38195507a14`, including `Tests` and `E2E Tests`.
- The main `Migration Drift Check` originally failed because prod was missing seven local migration ledger rows: `0322_bump_cloud_logging_retry_counts_rpc`, `0323_external_document_versions`, `0324_anchor_status_counts_read_cache`, `0325_public_search_min_length_and_timeouts`, `0326_scrum1649_deduct_org_credit_idempotency`, `0330_scrum2203_unembedded_records_query_perf`, and `0331_scrum1847_1869_public_anchor_cpe_cle_metadata`.
- These migrations were applied to prod through Supabase MCP project `vzwyaatejekddvltxyye` between 2026-06-08T19:29Z and 2026-06-08T19:32Z. Post-apply SQL verification showed all seven names present in `supabase_migrations.schema_migrations`.
- A fresh `Migration Drift Check` rerun completed successfully at 2026-06-08T19:34:10Z. Prod now matches the repo migration ledger for `main`.
- Non-release development may resume in isolated branches/worktrees only if it does not mutate shared staging, alter the release queue, or require main merges during the drain window.

## Implementation Update - 2026-06-08T19:46Z

Long-term RC manifest coverage has been implemented on branch `codex/release-queue-plan-20260608` without changing the required check name, branch protection, Mergify queue names, or workflow-required check semantics.

Implemented changes:

- `scripts/ci/check-staging-evidence.ts` now keeps existing per-PR evidence as the default path.
- The same `Staging Soak Evidence Gate` can also accept `RC manifest path: docs/staging/rc-manifests/rc-*.json`.
- RC manifests are local JSON only. External URLs and arbitrary paths fail closed.
- The gate validates release approval, exact current PR head coverage, base/train coverage, risk tier, clean preflight, deploy provenance, unexpired soak evidence, evidence links, and migration rollback/reapply proof for T3 or migration-bearing PRs.
- `.github/workflows/staging-evidence.yml` only adds `PR_NUMBER` as input data. The workflow name and job name are unchanged.
- Human-facing docs now include the RC manifest flow and a template in `docs/staging/rc-manifests/`.

Verification:

- `npx vitest run scripts/ci/check-staging-evidence.test.ts` passed, 123 tests.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `git diff --check` passed.
- `jq . docs/staging/rc-manifests/rc-template.json` passed.

This implementation is ready for release-owner review and merge. It does not by itself mutate current PRs or start any soak clock.

## Prod Migration Application Record

Operator action: reconcile prod migration ledger and schema to unblock the post-#1121 migration train. This was not a schema bypass; each migration was applied through the controlled Supabase MCP path against prod project `vzwyaatejekddvltxyye`.

Applied migrations:

- `0322_bump_cloud_logging_retry_counts_rpc`, ledger version `20260608192906`.
- `0323_external_document_versions`, ledger version `20260608192936`.
- `0324_anchor_status_counts_read_cache`, ledger version `20260608192959`.
- `0325_public_search_min_length_and_timeouts`, ledger version `20260608193024`.
- `0326_scrum1649_deduct_org_credit_idempotency`, ledger version `20260608193102`.
- `0330_scrum2203_unembedded_records_query_perf`, ledger version `20260608193114`.
- `0331_scrum1847_1869_public_anchor_cpe_cle_metadata`, ledger version `20260608193149`.

Verification summary:

- Required tables exist: `external_document_versions`, `version_reviews`, and `org_credit_deductions`.
- RLS is enabled and forced on the new tables.
- Required RPC/function bodies exist with expected `SECURITY DEFINER` posture and statement-timeout settings where applicable.
- Supabase security/performance advisors were run after DDL. The advisors reported existing extension, SECURITY DEFINER grant, MFA, public bucket, unindexed foreign key, duplicate index, and permissive-policy findings. One newly relevant performance follow-up is the missing covering index for `public.external_document_versions(anchor_id)`. Track this as a follow-up unless the release owner classifies it as a stop-train risk.

Current train posture:

- T3/migration PRs may begin only under the serial train controls below: freeze launch SHA, prove environment isolation, apply/rollback/reapply each migration in order, and capture prod proof after each merge.

## Immediate No-Touch Rule

Do not change current open PRs except for documented release-queue execution steps:

- Current open PR contents, labels, review state, branches, queue position, or comments.
- Mergify rules.
- Branch protection.
- Required check names.
- Additional `Staging Soak Evidence Gate` changes beyond the RC manifest implementation described above.
- Staging deployments, soak reruns, or queue reruns unless specifically authorized.

Documentation updates are allowed because they are the control record for the release-first mode.

## PR #1121 Production Proof

Before any T3 or migration-bearing PR starts soak or merge-readiness work, confirm #1121 is production-active. Required proof:

- Production deployment references `35023952a7657966c95e029ca480d38195507a14` or an immutable image/revision proven to contain that commit.
- Production health check is green after deployment.
- Smoke test covers the `edge-mcp` Nessie proxy path changed by #1121.
- Deploy log, image digest, Cloud Run revision, and health endpoint agree on the active SHA or immutable revision.
- Rollback path is known and can return to the prior production revision.
- Evidence is captured in the release record with timestamp, actor, command/log links, and observed result.

If this proof is missing or inconsistent, stop the train and do not begin T3 work.

## Short-Term Queue Drain

Current remaining strict order:

None. The Train A/B release drain is closed through #1122.

Already merged during the drain: #1055, #1047, #1101, #1100, #971, #1038, #1111, #1112, #1114, #1107, #1122.

Protected and no-touch PRs:

- #1087 is do-not-merge until explicitly reclassified and approved.
- #1106 remains a red-test draft. Do not treat expected red as actionable until the owner confirms it should move.
- #1105 requires a human T0/T1 decision before it enters any merge-readiness lane.
- Dependency-lane PRs stay separate unless they are urgent security fixes. They should not interleave with migration or T3 trains without release owner approval.

Queue-drain rules:

- Work one train at a time for migration/T3 risk.
- Freeze the train launch SHA before soak evidence collection.
- Do not start a downstream stacked PR until its upstream base and evidence state are known.
- If `main` moves, classify the drift before continuing. Main movement alone does not invalidate a soak. T0 docs/tests/CI/tooling-only drift may preserve evidence when the PR body records `Base drift impact:` with changed files, a no-runtime/schema/migration/staging/soak/deploy-impact assessment, and a named approver. Runtime, schema, migration, staging, deploy, or worker-image drift requires release-owner re-scope/retest.
- Capture why each PR is allowed into the lane: risk tier, CI status, soak/evidence status, owner approval, and rollback posture.

Drain progress note:

- #1055 merged 2026-06-10T23:35:49Z; older estimates that treated #1055 as
  pending are superseded.
- #1111 merged 2026-06-13T18:56:41Z as
  `b4d6cad1144d330fbb42322fdee8112630d9f2b4`; SCRUM-2236 is Done.
- #1112 merged 2026-06-13T20:12:01Z as
  `21d72078259918df13b0f573bb30861f4afae5fe`; SCRUM-2252 is Done.
- #1114 merged 2026-06-13T20:53:34Z as
  `b73a0545a20bab0fb9682b4e346031af2ca986ba`; SCRUM-2250 is Done.
- #1107 merged 2026-06-13T21:38:31Z as
  `8e62198345932a8e9ff25c41421adf112e3af6a0`; SCRUM-2244 is Done.
- #1122 merged 2026-06-13T22:26:18Z as
  `e51087a7990b349c09adca97797718a87c173e06`; SCRUM-2285 is Done.
- Final A/B soaks completed 2026-06-13T14:12:58Z /
  2026-06-13T14:12:59Z with `2880/2880` ok and zero failures.
- No Train A/B drain PRs remain.
- Safe development now: isolated feature branches/worktrees may continue if they do not mutate shared staging, main, Mergify, or the release queue.
- Safe normal dev merges: resume only after the RC manifest gate lands and the active release train can preserve evidence across controlled main movement, or after the current queue drains under the old process.

## T3 And Migration Safeguards

T3 and migration-bearing PRs require stronger isolation than ordinary T2 changes.

Hard gates:

- No T3 work starts before #1121 production-active proof is complete.
- The train launch SHA is frozen and written into the release record.
- PR head SHA, base SHA, container image digest, Cloud Run revision, deploy tag, deploy log, and health endpoint must agree.
- Staging database state must be proven as `clean_mirror` or isolated Supabase. Shared staging is not sufficient for migration soak unless the train explicitly owns that contamination window.
- Rollback and reapply proof is required for migrations.
- Load and soak harnesses must refuse T2/T3 runs when `STAGING_API_BASE` is missing or points at the shared/main staging URL.
- Migration ordering is serial. A later migration PR cannot begin until the prior migration PR has either merged with prod proof or been removed from the train.

Stop conditions:

- Any checksum, SHA, image, revision, deploy tag, or health endpoint mismatch.
- A migration changes shared staging state outside the active train.
- A rollback cannot be rehearsed or cannot be explained.
- Soak evidence cannot prove which build was exercised.
- `main` changes underneath an active train in a way that affects the target surface. T0-only CI/tooling drift is not by itself a stop condition when documented with an approved impact assessment.
- Production proof for #1121 is unavailable, stale, or contradictory.
- A dependency update enters the train without a release owner decision.

## Long-Term Release Candidate Model

The current bottleneck is not SOC 2 itself. The bottleneck is using per-PR long soaks on mutable shared staging as the main release-control mechanism. The long-term design should keep per-PR authorization and CI, but move long soak evidence to release candidates.

Preserve these per-PR controls:

- PR authorization and review trail.
- CI status and required checks.
- Risk tier classification.
- Change summary and rollback note.
- Owner approval.
- Traceability to issue, incident, or release objective.

Move these controls to a release-candidate record:

- Long T2/T3 soak window.
- Shared staging occupancy.
- Train membership.
- Combined rollback and deploy rehearsal.
- Production cutover proof.
- SOC 2 evidence packet.

Keep the required check name `Staging Soak Evidence Gate`. Teach the existing gate to accept either:

- Valid per-PR evidence for standalone PRs.
- Valid RC manifest coverage proving the PR is included in an approved release candidate whose evidence covers the PR head SHA, risk tier, environment, and soak window.

Evidence validity must be impact-based, not raw-SHA-panic-based. Exact PR head SHA remains mandatory: if the PR head changes, the tested artifact changed. Base SHA movement is different: when the intervening commits are T0 docs/tests/CI/tooling-only and do not affect runtime, schema, staging, deploy, worker image, or soak behavior, evidence can remain valid with a recorded `Base drift impact:` assessment and named approver. If the intervening commits touch runtime or migration surfaces, the gate must fail closed.

Avoid required-check name churn. Renaming required checks creates branch protection churn, breaks queue expectations, and weakens audit continuity.

## RC Manifest Fields

The RC manifest should be machine-readable and stored with the release record. Minimum fields:

- `rc_id`.
- `created_at`.
- `created_by`.
- `release_owner`.
- `approval_status`.
- `approval_actor`.
- `approval_time`.
- `train_launch_sha`.
- `target_main_sha`.
- `included_prs` with PR number, head SHA, base SHA, risk tier, owner, CI summary, and rollback note.
- `excluded_prs` with reason.
- `environment` with staging URL, Cloud Run service, revision, deploy tag, image digest, and Supabase project or `clean_mirror` proof.
- `soak` with start, end, duration, harness version, `STAGING_API_BASE`, result, and evidence links.
- `migration_plan` with order, rollback proof, reapply proof, and stop conditions.
- `prod_cutover` with deployed SHA or revision, health check, smoke result, rollback readiness, actor, and timestamp.
- `exceptions` with explicit approval and compensating control.

## SOC 2 Evidence Artifacts

For each release candidate, retain:

- PR authorization and approval trail.
- CI and required-check evidence.
- Risk-tier decision.
- Soak evidence or RC manifest coverage.
- Change-management approval.
- Migration and rollback evidence when applicable.
- Production deployment proof.
- Post-deploy smoke result.
- Exceptions and compensating controls.

The auditor-facing statement should be: changes remain authorized, tested, approved, traceable, deployed by controlled process, and verified after production release. Long soak is centralized at the RC level when PRs are batched, not skipped.

## Operations Dashboard Requirements

The dashboard should make queue state obvious enough that Carson does not have to manually reconstruct it.

Required fields:

- PR number, title, owner, branch, head SHA, base SHA, and risk tier.
- Current lane: backlog, ready, soaking, queued, merged, blocked, no-touch, dependency lane.
- Required checks with expected-red vs actionable-red buckets.
- Soak status, evidence TTL, start/end time, environment URL, and active SHA.
- Active soak inventory by staging resource and Supabase project.
- Migration train membership and order.
- Queue position and Mergify state.
- Merge-to-prod latency.
- Production proof status.
- Manual-decision alerts for #1105-like ambiguity, dependency-lane escalation, stale evidence, and stop-train red flags.

## Operating Rhythm

Use this rhythm until the queue is healthy:

- Start of day: refresh `main`, queue state, active soaks, expected-red list, and manual-decision alerts.
- Before each merge-readiness move: confirm #1121 prod proof, train launch SHA, risk tier, CI state, and environment isolation.
- During soak: no unrelated staging contamination for the active train.
- After merge: capture production proof and decide whether the next PR can use existing evidence or needs new evidence.
- End of day: update the queue dashboard and release record with what moved, what is blocked, and who owns the next decision.

## Manual Approval Points

Release owner approval is required for:

- Merging the RC manifest gate implementation branch.
- Starting any T3 or migration train.
- Allowing dependency-lane work to interleave with the release train.
- Reclassifying #1087 from do-not-merge.
- Moving #1105 into T0/T1 or a higher-risk lane.
- Treating #1106 red tests as expected rather than actionable.
- Accepting an RC manifest as coverage for the `Staging Soak Evidence Gate`.
- Proceeding after any stop-train red flag.

## Phase 2 Audit Scope

After the immediate queue is moving, audit the broader development process:

- PR lifecycle ownership and stale PR closure.
- Risk-tier classification accuracy.
- Required-check inventory and naming stability.
- Staging resource isolation.
- Migration train governance.
- Evidence retention and TTL policy.
- Dashboard ownership.
- Documentation freshness and source-of-truth rules.
