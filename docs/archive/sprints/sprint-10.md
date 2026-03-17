I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

This sprint is cleanup and CI health. No new features.

Create branch `fix/cleanup-ci-health` from main.

Tasks:
1. Review stale PR #21 (feat/p7-ts02-stripe-checkout-p7-ts09-webhook-settings). Check if all changes are already on main. If so, close it with a comment explaining it's been superseded. Use `gh pr close 21 --comment "..."`.
2. Review stale PR #26 (feat/crit2-complete). Same — check if changes are on main, close if superseded.
3. Clean up stale local branches: delete any `worktree-agent-*` branches, old feature branches that are already merged. Use `git branch -d` (safe delete only).
4. Run full test suite and fix any flaky tests or warnings: `npm test`, `npm run test:coverage`. Address the React act() warning in AssetDetailView.test.tsx and the DOM nesting warning in RevokeDialog.test.tsx if possible.
5. Run `npm audit` and fix any vulnerabilities that can be auto-fixed. Report any that need manual review.

Push any test fixes, create PR with title "chore: stale PR cleanup + test warning fixes".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update MEMORY.md branch status and session handoff notes.
