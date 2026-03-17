I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

Execute DH Hardening Batch 2 — 3 deferred hardening stories focused on observability and data integrity.

Create branch `fix/dh-hardening-batch-2` from main.

Implement using TDD:
1. DH-05: Chain index cache TTL — add TTL-based caching to SupabaseChainIndexLookup (services/worker/src/chain/client.ts) to reduce DB queries for frequently-verified fingerprints
2. DH-11: Worker RPC structured logging — replace console.log calls in worker with structured JSON logging (correlation IDs, timestamps, log levels). Use the existing logger utility in services/worker/src/utils/
3. DH-12: Webhook dead letter queue — after circuit breaker exhausts retries, move failed webhook events to a dead_letter_webhooks table for manual inspection. Create migration for the table.

For DH-12: create migration file (next sequential number after 0051), include ROLLBACK comment, add RLS policy, regenerate types.

After all fixes, run: npx tsc --noEmit && npm run lint && npm test && npm run lint:copy

Create a single commit, push, and create PR against main with title "fix: DH hardening batch 2 — cache TTL, structured logging, webhook DLQ".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update CLAUDE.md Section 8, HANDOFF.md, and MEMORY.md.
