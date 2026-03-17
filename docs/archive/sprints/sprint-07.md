I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

Execute DH Hardening Batch 1 — 3 deferred hardening stories focused on resilience. These are documented in docs/stories/10_deferred_hardening.md.

Create branch `fix/dh-hardening-batch-1` from main.

Implement these stories using TDD (Red-Green-Refactor):
1. DH-01: Feature flag hot-reload — add polling/realtime subscription to switchboard.ts so flag changes take effect without restart
2. DH-04: Webhook circuit breaker — add circuit breaker pattern to webhook delivery engine (services/worker/src/webhooks/delivery.ts). After N consecutive failures to an endpoint, stop attempting delivery for a cooldown period.
3. DH-06: ConfirmAnchorModal server-side quota error handling — when check_anchor_quota RPC returns an error or quota exceeded, show user-friendly error in ConfirmAnchorModal instead of silent failure

For each story: write failing test first, implement minimum code to pass, refactor. Verify with Playwright for any UI changes (DH-06).

After all fixes, run: npx tsc --noEmit && npm run lint && npm test && npm run lint:copy

Create a single commit, push, and create PR against main with title "fix: DH hardening batch 1 — flag reload, webhook circuit breaker, quota errors".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update CLAUDE.md Section 8 (DH status), HANDOFF.md, and MEMORY.md.
