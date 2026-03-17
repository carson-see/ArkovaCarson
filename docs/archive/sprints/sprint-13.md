I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

Execute MVP Feature Gaps Batch 1 — 3 high-value features.

Create branch `feat/mvp-features-batch-1` from main.

Implement using TDD:
1. MVP-06: File-based public verification (drag-and-drop) — Add a drag-and-drop zone to the public verification page (/verify) that accepts a file, hashes it client-side using fileHasher.ts, and looks up the fingerprint via the verify endpoint. No file leaves the browser (Constitution 1.6).
2. MVP-16: Block explorer deep links — In AssetDetailView.tsx, when an anchor has chain_tx_id, show a "View on Network" link that opens the appropriate block explorer (mempool.space for mainnet/signet). Use copy.ts for the link text (avoid banned terms).
3. MVP-21: Individual self-verification flow — Allow INDIVIDUAL users to verify their own documents from the vault. Add a "Verify" button on record cards that triggers the client-side hash + lookup flow.

Verify all UI changes with Playwright MCP tool.

After all fixes, run: npx tsc --noEmit && npm run lint && npm test && npm run lint:copy

Create a single commit, push, and create PR against main with title "feat: MVP features batch 1 — file verification, explorer links, self-verify".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback.

Update CLAUDE.md Section 8, HANDOFF.md, and MEMORY.md.
