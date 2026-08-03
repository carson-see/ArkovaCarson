# Arkova Memory Files — `feedback_*.md` rule index

> Rule index only. This directory records durable engineering preferences and
> enforcement mechanisms; it is not project status, backlog, or release truth.

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
`scripts/ci/check-doc-pointers.ts` now fails CI if CLAUDE.md, AGENTS.md, a
skill, or a hook cites a `memory/` path that does not resolve. Before that
check existed, 17 cited rule files were missing, including one named inside a
hook's own deny message.

| Memory file | Enforcement | Status |
|---|---|---|
| `feedback_migration_rules.md` | `.claude/hooks/check-constitution-on-edit.sh` — **BLOCK** (never-modify, `NNNN` collision, missing `-- ROLLBACK:`) + migration-drift CI gate | ✅ live |
| `feedback_migration_number_vs_reservations.md` | `.claude/hooks/check-constitution-on-edit.sh` — **BLOCK**; named in the deny message | ✅ live |
| `feedback_no_credit_limits_beta.md` | CI lint (`no-credit-limits-beta.ts`) | ✅ live (R0-7) |
| `feedback_no_aws.md` | CI lint (`no-aws.ts`) | ✅ live (R0-7) |
| `feedback_pr_target_repo.md` | CI lint (`pr-target-repo.ts`) | ✅ live (R0-7) |
| `feedback_no_worktree_isolation.md` | CI lint (`no-worktree-isolation.ts`) | ✅ live (R0-7) |
| `feedback_local_matches_prod.md` | CI lint (`feedback_local_matches_prod.ts`) — snapshot diff vs `scripts/ci/snapshots/prod-tables.json`; fails closed. Live-MCP comparison still deferred. | ✅ live (SCRUM-1306 / R0-7-FU1) |
| `feedback_dont_recommend_do.md` | CI lint **advisory** (`feedback_dont_recommend_do.ts`) — always exits 0, never blocks | ✅ live (SCRUM-1306) |
| `feedback_jira_user_story_format.md` | Atlassian Automation (SCRUM project rules; see CLAUDE.md §5.1). CI file `feedback_jira_user_story_format.ts` is a no-op stub. | ✅ live (SCRUM-1306) |
| `feedback_confluence_every_story.md` | Atlassian Automation R4 (Done-transition DoD gate) + CI drift guard `scripts/ci/check-confluence-coverage.ts` (warn-only) | ✅ live (R0-5 / SCRUM-1207) |
| `feedback_never_merge_without_ok.md` | Agent hook `.claude/hooks/block-pr-merge.sh` (exit 2 on `gh pr merge`) + Mergify queue policy in `.mergify.yml`. *Not* Atlassian R5 — that rule gates Jira Done on red checks. | ✅ live |
| `feedback_merges_go_through_mergify.md` | `.mergify.yml` queue rules + `.github/workflows/merge-authority.yml` tier marker | 📖 docs only (policy) |
| `feedback_confluence_is_the_doc.md` | Documentation only (CLAUDE.md §0 rule 4, §3 gate 3, §4 Doc Update Matrix) | 📖 docs only |
| `feedback_vertex_endpoint_hygiene.md` | Documentation only (CLAUDE.md §0 rule 7 + §7 end-of-sprint infra sweep) | 📖 docs only |
| `feedback_worker_hands_off.md` | Documentation only (agent-author detection unreliable) | 📖 docs only |
| `feedback_nvi_lawyer_scope.md` | Documentation only (Jira scoping decision, 2026-04-27) | 📖 docs only |

## Override pattern

CI lint rules support override via PR label. The label name is rule-specific
and documented in the rule script. Examples:

- `post-beta-quota-rollout` → overrides `feedback_no_credit_limits_beta`
- `aws-intentional` → overrides `feedback_no_aws`
- `local-matches-prod-skip` → overrides `feedback_local_matches_prod`
- `confluence-drift-skip` → overrides the Confluence coverage drift guard
- `handoff-narrative-only` → overrides R0-6 HANDOFF.md lint

`feedback_pr_target_repo` and `feedback_no_worktree_isolation` have **no**
override label. `feedback_dont_recommend_do` needs none — it cannot fail.

If you find yourself reaching for an override more than once, file a Jira
sub-story to update the policy and remove the override path.
- `worktree-branch-exception` -> overrides feedback_no_worktree_isolation (branch-name lint; added 2026-08-01 for #1737)
