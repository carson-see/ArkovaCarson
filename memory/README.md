# Arkova Memory Files — `feedback_*.md` rule index

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

| Memory file | Enforcement | Status |
|---|---|---|
| `feedback_no_credit_limits_beta.md` | CI lint (`no-credit-limits-beta.ts`) | ✅ live (R0-7) |
| `feedback_no_aws.md` | CI lint (`no-aws.ts`) | ✅ live (R0-7) |
| `feedback_pr_target_repo.md` | CI lint (`pr-target-repo.ts`) | ✅ live (R0-7) |
| `feedback_no_worktree_isolation.md` | CI lint (`no-worktree-isolation.ts`) | ✅ live (R0-7) |
| `feedback_never_merge_without_ok.md` | Atlassian Automation R5 | ✅ live (R0-5) |
| `feedback_jira_user_story_format.md` | Atlassian Automation issue-create rule (CI stub: `feedback_jira_user_story_format.ts`) | ✅ live (SCRUM-1306) |
| `feedback_confluence_every_story.md` | Atlassian Automation R4 | ✅ live (R0-5) |
| `feedback_worker_hands_off.md` | Documentation only (agent-author detection unreliable) | 📖 docs only |
| `feedback_local_matches_prod.md` | CI lint stub (`feedback_local_matches_prod.ts`, needs Supabase MCP) | ⏳ stub (SCRUM-1306) |
| `feedback_dont_recommend_do.md` | CI lint advisory (`feedback_dont_recommend_do.ts`) | ✅ live (SCRUM-1306) |

## Override pattern

CI lint rules support override via PR label. The label name is rule-specific
and documented in the rule script. Examples:

- `post-beta-quota-rollout` → overrides `feedback_no_credit_limits_beta`
- `aws-intentional` → overrides `feedback_no_aws`
- `handoff-narrative-only` → overrides R0-6 HANDOFF.md lint

If you find yourself reaching for an override more than once, file a Jira
sub-story to update the policy and remove the override path.
