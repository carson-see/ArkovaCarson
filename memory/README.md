# Arkova Memory Files — rule index

> Rule index only. This directory records durable engineering preferences and
> enforcement mechanisms; it is not project status, backlog, or release truth.
>
> Most files are `feedback_*.md` — a preference or policy, with an enforcement
> mechanism. A `project_*.md` file records a durable **failure class** that
> existing gates exist to prevent: the mechanism, the blast radius, and which
> gates hold it shut. Neither kind carries status, dates, or backlog.

These files capture engineering preferences and policy decisions that
should outlast individual sessions. Each rule is enforced one of three ways:

| Enforcement | What it looks like |
|---|---|
| **Atlassian Automation** | Jira rule blocks issue transitions or PR-related events. See `docs/jira-workflow/automation-rules.json` (R0-5). |
| **CI lint script** | Per-rule `.ts` file under `scripts/ci/feedback-rules/` that returns exit 1 on violation. Orchestrated by `scripts/ci/check-feedback-rules.ts` (R0-7). |
| **Documentation only** | Rule is human-judgement; no automation. |

## Adding a new rule

1. Write the `feedback_<name>.md` describing the rule's WHY + HOW TO APPLY.
2. Pick an enforcement mechanism above.
3. If CI lint:
   - Drop `scripts/ci/feedback-rules/<name>.ts` with `#!/usr/bin/env -S npx tsx` shebang.
   - Exit 0 = pass, 1 = violation, 2 = config error.
   - Read `process.env.PR_LABELS` for override checks.
   - Run `npx tsx scripts/ci/check-feedback-rules.ts` locally to verify.
4. If Atlassian Automation:
   - Add the rule object to `docs/jira-workflow/automation-rules.json`.
   - Mirror it in the Jira UI under SCRUM project automation.
5. Add the rule to the index below.

## Current rules

Every row below points at a file that exists in this directory — and
`scripts/ci/check-doc-pointers.ts` fails CI if a `memory/` path cited by the
required-reading set does not resolve. Before that check existed, 17 cited rule
files were missing, including one named inside a hook's own deny message.

The scan set was widened on 2026-08-31 to the **nested `agents.md`** files and
the **comment lines** of `.github/workflows/*.yml`. Both cite this corpus and
neither was covered, so `memory/project_deploy_typecheck_blackout.md` sat dead
across six sites — including two CI gate sources — until someone found it by
hand. That widening surfaced five more dead `memory/` pointers, each of which
named a rule that lived only in one session's private memory. **A rule that
exists only in a session's local memory does not exist** (CLAUDE.md §0.1): if
you cite `memory/x.md`, the file has to be in this directory.

| Memory file | Enforcement | Status |
|---|---|---|
| `feedback_migration_rules.md` | `.claude/hooks/check-constitution-on-edit.sh` — **BLOCK** (never-modify, `NNNN` collision, missing `-- ROLLBACK:`) + migration-drift CI gate | ✅ live |
| `feedback_migration_number_vs_reservations.md` | `.claude/hooks/check-constitution-on-edit.sh` — **BLOCK**; named in the deny message | ✅ live |
| `feedback_no_credit_limits_beta.md` | CI lint (`no-credit-limits-beta.ts`) | ✅ live (R0-7) |
| `feedback_no_aws.md` | CI lint (`no-aws.ts`) | ✅ live (R0-7) |
| `feedback_bounded_body_reads.md` | CI lint (`bounded-body-reads.ts`) — raw `.json()`/`.text()` on a fetch response under `services/worker/src/**`, scoped to lines the PR **adds** (145 pre-existing sites; see the rule's header for why whole-file would be wrong here). Override `unbounded-body-read-reviewed`. The companion `maxRunMs >= ttlMs` half is test-enforced in `jobs/__tests__/run-lease.deadline.test.ts`. | ✅ live (R0-7 / F-D0-5) |
| `feedback_pr_target_repo.md` | CI lint (`pr-target-repo.ts`) | ✅ live (R0-7) |
| `feedback_no_worktree_isolation.md` | CI lint (`no-worktree-isolation.ts`) | ✅ live (R0-7) |
| `feedback_surrogate_safe_truncation.md` | CI lint (`surrogate-safe-truncate.ts`) — ratchet vs `surrogate-truncate-baseline.json`; merge-time gate is its colocated `.test.ts` in `Tests` | ✅ live (R0-7) |
| `feedback_local_matches_prod.md` | CI lint (`feedback_local_matches_prod.ts`) — snapshot diff vs `scripts/ci/snapshots/prod-tables.json`; fails closed. Live-MCP comparison still deferred. | ✅ live (SCRUM-1306 / R0-7-FU1) |
| `feedback_dont_recommend_do.md` | CI lint **advisory** (`feedback_dont_recommend_do.ts`) — always exits 0, never blocks | ✅ live (SCRUM-1306) |
| `feedback_jira_user_story_format.md` | Atlassian Automation (SCRUM project rules; see CLAUDE.md §5.1). CI file `feedback_jira_user_story_format.ts` is a no-op stub. | ✅ live (SCRUM-1306) |
| `feedback_confluence_every_story.md` | Atlassian Automation R4 (Done-transition DoD gate) + CI drift guard `scripts/ci/check-confluence-coverage.ts` (warn-only) | ✅ live (R0-5 / SCRUM-1207) |
| `feedback_never_merge_without_ok.md` | Agent hook `.claude/hooks/block-pr-merge.sh` (exit 2 on `gh pr merge`) + Mergify queue policy in `.mergify.yml`. *Not* Atlassian R5 — that rule gates Jira Done on red checks. | ✅ live |
| `feedback_git_merge_driver_override.md` | Agent hook `.claude/hooks/check-git-merge-driver-flag.sh` (exit 2 on a transient `-c merge.*.driver=` override) + bootstrap config scan `scripts/agent/check-git-merge-config.sh` + cause-agnostic CI backstop `scripts/ci/check-agents-md-append-only.ts`. No override label — a no-op driver is never intentional. | ✅ live |
| `feedback_secdef_function_grants.md` | CI lint (`secdef-function-grants.ts`), auto-loaded by the `check-feedback-rules.ts` orchestrator's `Policy Lints` job; merge-time gate is `secdef-function-grants.test.ts` in `Tests`. Burn-down baseline in `scripts/ci/feedback-rules/secdef-grants-baseline.json`. | ✅ live (R0-7) |
| `feedback_relation_anon_grants.md` | CI lint (`relation-anon-grants.ts`) — the RELATION axis (tables/views/matviews/sequences) of the same defect `secdef-function-grants.ts` guards for functions; that rule is function-shaped throughout and could never see a view, which is why `v_slow_queries` survived both `0414` and `0418`. Pins in `REPLAY_PARITY_REVOKES`; merge-time gate is `relation-anon-grants.test.ts` in `Tests`. No override label — removing a pin is the escape hatch. | ✅ live (R0-7) |
| `feedback_merges_go_through_mergify.md` | `.mergify.yml` queue rules + `.github/workflows/merge-authority.yml` tier marker | 📖 docs only (policy) |
| `feedback_confluence_is_the_doc.md` | Documentation only (CLAUDE.md §0 rule 4, §3 gate 3, §4 Doc Update Matrix) | 📖 docs only |
| `feedback_vertex_endpoint_hygiene.md` | Documentation only (CLAUDE.md §0 rule 7 + §7 end-of-sprint infra sweep) | 📖 docs only |
| `feedback_worker_hands_off.md` | Documentation only (agent-author detection unreliable) | 📖 docs only |
| `feedback_nvi_lawyer_scope.md` | Documentation only (Jira scoping decision, 2026-04-27) | 📖 docs only |
| `feedback_verify_cloud_project_before_auth.md` | Documentation only (no reliable detector for a wrong project ID) | 📖 docs only |
| `feedback_read_the_emitting_code.md` | Documentation only (no detector for "did not read the function") | 📖 docs only |

## Failure-class notes

| Memory file | Enforcement | Status |
|---|---|---|
| `project_deploy_typecheck_blackout.md` | CI lint ×3 — `check-deploy-lint-parity.ts` (R0-4 / SCRUM-1250), `check-deploy-build-parity.ts`, `check-deploy-typecheck-parity.ts` (SCRUM-1811). All three are pure file readers in the required `typecheck-lint` job. Override `ci-config-change` at the workflow level. | ✅ live |

## Override pattern

CI lint rules support override via PR label. The label name is rule-specific
and documented in the rule script. Examples:

- `post-beta-quota-rollout` → overrides `feedback_no_credit_limits_beta`
- `aws-intentional` → overrides `feedback_no_aws`
- `local-matches-prod-skip` → overrides `feedback_local_matches_prod`
- `confluence-drift-skip` → overrides the Confluence coverage drift guard
- `handoff-narrative-only` → overrides R0-6 HANDOFF.md lint
- `secdef-grants-skip` → overrides `feedback_secdef_function_grants`
- `unbounded-body-read-reviewed` → overrides `feedback_bounded_body_reads`

`feedback_pr_target_repo`, `feedback_no_worktree_isolation` and
`feedback_relation_anon_grants` have **no** override label (for the last, removing
the `REPLAY_PARITY_REVOKES` pin is the deliberate, reviewable escape hatch). `feedback_dont_recommend_do` needs none — it cannot fail.

If you find yourself reaching for an override more than once, file a Jira
sub-story to update the policy and remove the override path.
- `worktree-branch-exception` -> overrides feedback_no_worktree_isolation (branch-name lint; added 2026-08-01 for #1737)
- `surrogate-slice-reviewed` -> overrides `feedback_surrogate_safe_truncation` (surrogate-safe truncation ratchet; added 2026-08-17)
