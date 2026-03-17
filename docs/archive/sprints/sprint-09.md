I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

Execute DH Hardening Batch 3 — 3 remaining deferred hardening stories.

Create branch `fix/dh-hardening-batch-3` from main.

Implement using TDD:
1. DH-02: Advisory lock for bulk_create_anchors — add Postgres advisory lock to prevent concurrent bulk anchor creation for the same org. Create migration with pg_advisory_xact_lock.
2. DH-08: Rate limiting for check_anchor_quota — add rate limiting to the check_anchor_quota RPC to prevent quota check abuse. Implement in worker middleware or as a Postgres function rate limit.
3. DH-10: useEntitlements realtime subscription — subscribe to Supabase realtime changes on the subscriptions/billing tables so entitlement state updates without page refresh.

For DH-02: create migration file, include ROLLBACK comment.
For DH-10: verify with Playwright MCP tool that entitlement changes reflect in UI.

After all fixes, run: npx tsc --noEmit && npm run lint && npm test && npm run lint:copy

Create a single commit, push, and create PR against main with title "fix: DH hardening batch 3 — advisory locks, quota rate limit, realtime entitlements".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update CLAUDE.md Section 8 (all 12 DH stories should now be COMPLETE), HANDOFF.md, and MEMORY.md.
