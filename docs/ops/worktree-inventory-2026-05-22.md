# Arkova Worktree Inventory - 2026-05-22 Historical Snapshot

> Historical evidence only. This file records the worktree state observed on
> 2026-05-22. It is not a current inventory and must not be used to decide
> whether a worktree or PR is still open. Regenerate current state from
> `git worktree list`, per-worktree `git status --short --branch`, and
> `gh pr list`.

This inventory was captured from the canonical checkout:

```text
/Volumes/Extreme/Arkova/arkova-mvpcopy-main
branch: main at capture start, then codex/workspace-hygiene-20260522 for guardrail edits
origin: https://github.com/carson-see/ArkovaCarson.git
```

No worktrees were deleted, reset, or overwritten during this inventory.
After the initial inventory, two reversible hygiene actions were taken:

- Root-level stray `src`, `services`, and `supabase/.temp` directories were
  quarantined under
  `/Volumes/Extreme/Arkova/quarantine/root-container-strays-20260522T175541Z`.
- The misleading worktree path `/Volumes/Extreme/Arkova/worktrees/main-clean`
  was renamed with `git worktree move` to
  `/Volumes/Extreme/Arkova/worktrees/scrum-1821-closeout-fixes-dirty`.

## Executive Summary

- `/Volumes/Extreme/Arkova` is a workspace container, not a git repo.
- Canonical checkout: `/Volumes/Extreme/Arkova/arkova-mvpcopy-main`.
- Registered worktrees: 75.
- Clean worktrees: 54.
- Dirty worktrees: 21.
- Clean worktrees whose HEAD is already an ancestor of `origin/main`: 20.
- Dirty worktrees whose HEAD is already an ancestor of `origin/main`: 9.
- Clean worktrees whose HEAD is not an ancestor of `origin/main`: 34.
- Dirty worktrees whose HEAD is not an ancestor of `origin/main`: 12.

## Root-Level Hazards

These paths exist directly under `/Volumes/Extreme/Arkova` and are not part of the canonical checkout:

| Path | Finding | Action |
|---|---|---|
| `/Volumes/Extreme/Arkova/src` | Empty shell directory with `src/lib`; no files found. | Quarantined. |
| `/Volumes/Extreme/Arkova/services` | Empty shell directory with nested worker script folders; no files found. | Quarantined. |
| `/Volumes/Extreme/Arkova/supabase/.temp` | Supabase CLI temp state outside any repo. It pointed at staging and could mislead Supabase commands run from the workspace root. | Quarantined. |
| `/Volumes/Extreme/Arkova/worktrees/main-clean` | Misleading name. It was on `codex/scrum-1821-closeout-fixes`, dirty, and not clean main. | Renamed to `/Volumes/Extreme/Arkova/worktrees/scrum-1821-closeout-fixes-dirty`. |

## Open PR Worktrees

These branches have open GitHub PRs as of 2026-05-22 and should not be removed as cleanup candidates.

| PR | Branch | Local checkout |
|---|---|---|
| #862 | `codex/scrum-1875-ctdl-r0-hardening` | `/Volumes/Extreme/Arkova/worktrees/scrum-1875-ctdl-r0-hardening` |
| #861 | `codex/scrum-1953-golden-phase5` | `/Volumes/Extreme/Arkova/worktrees/scrum-1953-golden-phase5` |
| #859 | `codex/api-v1-anchor-scope-alias-20260522` | `/Volumes/Extreme/Arkova/worktrees/api-v1-anchor-scope-alias-20260522` |
| #858 | `chore/bump-package-versions-to-2.2.0` | `/Volumes/Extreme/Arkova/worktrees/bump-package-versions-to-2.2.0` |
| #856 | `codex/pr841-ledger-remediation-20260521` | `/Users/carson/.config/superpowers/worktrees/arkova-mvpcopy-main/codex/pr841-ledger-remediation-20260521` |
| #852 | `codex/scrum-1955-fraud-webworker` | `/Volumes/Extreme/Arkova/worktrees/scrum-1955-fraud-webworker` |
| #850 | `codex/scrum-1868-cle-api-sanitizer` | `/Volumes/Extreme/Arkova/worktrees/scrum-1868-cle-api-sanitizer` |
| #849 | `codex/scrum-1949-provider-refresh-controls` | `/Volumes/Extreme/Arkova/worktrees/scrum-1949-provider-refresh-controls` |
| #848 | `fix/worker-lint-warnings-cleanup` | No registered worktree found in this inventory. |
| #847 | `codex/scrum-1964-native-batch-embeddings` | `/Volumes/Extreme/Arkova/worktrees/scrum-1964-native-batch-embeddings` |
| #844 | `fix/queue-pending-500-auth-uid-null` | `/Volumes/Extreme/Arkova/arkova-docusign-cors` |
| #840 | `codex/docusign-post-812-secret-cleanup` | `/Volumes/Extreme/Arkova/worktrees/docusign-post-812-cleanup` |
| #838 | `codex/scrum-1286-anchors-index-consolidation` | `/Users/carson/.config/superpowers/worktrees/arkova-mvpcopy-main/codex-scrum-1286-anchors-index-consolidation` |
| #813 | `fix/worker-lint-remaining` | `/Volumes/Extreme/Arkova/worktrees/pr-813-lint-agent` |
| #810 | `fix/tenant-isolation-proper` | `/Volumes/Extreme/Arkova/worktrees/pr-810-lint-agent` |

## Dirty Worktrees

Dirty worktrees are preservation-first. They must be resolved, parked, or explicitly abandoned before deletion.

| Path | Branch | HEAD | Dirty paths | HEAD in `origin/main` |
|---|---|---:|---:|---|
| `/Volumes/Extreme/Arkova/worktrees/nessie-readiness-20260513` | `nessie/readiness-audit-20260513` | `e34d323f` | 44 | yes |
| `/Volumes/Extreme/Arkova/worktrees/pr-817-provenance-agent` | `codex/pr-817-provenance-agent` | `a6d3d331` | 15 | no |
| `/Volumes/Extreme/Arkova/worktrees/anchor-status-truth-hotfix` | `codex/anchor-status-truth-hotfix` | `8a6e5f77` | 13 | yes |
| `/Volumes/Extreme/Arkova/worktrees/pr-812-docusign-agent` | `feat/scrum-1101-docusign-connect-provision` | `60021ed1` | 13 | yes |
| `/Volumes/Extreme/Arkova/worktrees/pr-817-current-fix` | `codex/pr-817-review-fixes-current` | `5e51b838` | 12 | no |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1821-closeout-fixes-dirty` | `codex/scrum-1821-closeout-fixes` | `22704333` | 9 | yes |
| `/Volumes/Extreme/Arkova/worktrees/pr-774-fix` | `(detached)` | `7e036a5d` | 6 | no |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1649-docusign-action-modes` | `codex/scrum-1649-docusign-action-modes` | `180cbd24` | 3 | no |
| `/Volumes/Extreme/Arkova/worktrees/fraud-disable` | `claude/disable-ai-fraud-and-fix-flag-middleware` | `65d7dcd9` | 2 | no |
| `/Volumes/Extreme/Arkova/worktrees/pr-658` | `claude/dreamy-banzai-cbcad4` | `d955feea` | 2 | no |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1798-credential-issued` | `codex/scrum-1798-credential-issued` | `a2685988` | 2 | yes |
| `/Volumes/Extreme/Arkova/worktrees/pr-653` | `claude/focused-fermi-s6ABx` | `13825a8b` | 1 | no |
| `/Volumes/Extreme/Arkova/worktrees/pr-663` | `codex/api-agent-contract-workflows` | `56ecc71a` | 1 | no |
| `/Volumes/Extreme/Arkova/worktrees/pr-675` | `codex/scrum-897-attestation-evidence` | `e9de5bbc` | 1 | yes |
| `/Volumes/Extreme/Arkova/worktrees/pr-774-clean` | `codex/p0-truth-drain-followup-20260513` | `8ff2065e` | 1 | no |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1302-salvage` | `claude/scrum-1302-auth-setup-hardening` | `8a00e445` | 1 | no |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1566-pysdk-consolidation` | `claude/scrum-1566-python-sdk-consolidation` | `b4a07592` | 1 | yes |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1584-followup` | `claude/scrum-1584-agent-surface-followup` | `bdcd79c0` | 1 | yes |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1598-credential-source-import` | `codex/scrum-1598-credential-source-import` | `6ce849ef` | 1 | no |
| `/Volumes/Extreme/Arkova/worktrees/scrum-1647-path-c-baseline` | `claude/scrum-1647-path-c-pg-dump-baseline` | `5780e66a` | 1 | no |
| `/Volumes/Extreme/Arkova/worktrees/scrum-908-followup` | `claude/scrum-908-jq-er-hardening` | `2f5fbdef` | 1 | yes |

## Cleanup Policy

Use this order. Do not skip ahead.

1. Run `scripts/ops/workspace-preflight.sh` before any Arkova code/session work.
2. Keep root-level `src`, `services`, and `supabase/.temp` quarantined unless intentionally restored.
3. Keep misleading worktree names out of `/Volumes/Extreme/Arkova/worktrees`; rename with `git worktree move` instead of raw `mv`.
4. Preserve all dirty worktrees until each has an owner decision.
5. Preserve all open PR worktrees until the PR merges/closes.
6. Remove only clean worktrees whose HEAD is merged to `origin/main`, with `git worktree remove`, then `git worktree prune`.
7. Re-run this inventory and update this file after cleanup.
