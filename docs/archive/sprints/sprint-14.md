I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

Execute MVP Feature Gaps Batch 2 — credits system and metadata enhancements.

Create branch `feat/mvp-features-batch-2` from main.

Implement using TDD:
1. MVP-24: Credits schema + monthly allocations — Create migration for credits table (user_id, credits_remaining, credits_monthly_allocation, credits_purchased, reset_date). Tier allocations: Free=50, Pro=500, Enterprise=5000. Create useCredits hook. Wire into ConfirmAnchorModal as secondary gate after quota check.
2. MVP-25: Credits tracking + scheduling — Deduct credits on anchor creation. Add monthly reset logic to worker cron. Show credits remaining in DashboardPage stat cards.
3. MVP-17: Credential template metadata enhancement — Extend credential_templates table with a metadata_schema JSONB column (migration). UI for defining required/optional metadata fields per template. Wire into IssueCredentialForm.

For MVP-24: create migration, include ROLLBACK comment, add RLS policy, regenerate types.
Verify UI changes with Playwright.

After all fixes, run: npx tsc --noEmit && npm run lint && npm test && npm run lint:copy

Create a single commit, push, and create PR against main with title "feat: MVP features batch 2 — credits system, metadata templates".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update CLAUDE.md Section 8, HANDOFF.md, and MEMORY.md.
