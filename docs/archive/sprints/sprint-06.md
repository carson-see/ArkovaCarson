I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

Execute Sprint 6 — 8 medium+low UAT polish bugs. These are documented in docs/stories/14_uat_sprints.md and docs/bugs/uat_2026_03_15.md.

Create branch `fix/uat-sprint-6` from main.

Fix these bugs in this order:
1. BUG-UAT-11: Stat cards stacked vertically on desktop — fix grid classes in DashboardPage.tsx / StatCard.tsx
2. BUG-UAT-10: Secure Document button overlaps subtitle — fix layout in MyRecordsPage.tsx
3. BUG-UAT-13: Account Type dual labels confusing — simplify in DashboardPage.tsx
4. BUG-UAT-12: Tablet viewport clips content — check AppShell.tsx overflow, may already be fixed by Sprint 5 sidebar work
5. BUG-UAT-15: No "Forgot Password" link — add to LoginForm.tsx, wire to supabase.auth.resetPasswordForEmail
6. BUG-UAT-17: QR code URL shows localhost — use VITE_APP_URL env var in AssetDetailView.tsx
7. BUG-UAT-16: No loading states — add Skeleton/shimmer to DashboardPage, RecordsList, OrgRegistryTable during data fetch
8. BUG-UAT-14: Seed data visible — add note to supabase/seed.sql marking demo data for pre-launch strip

Verify each fix with the Playwright MCP tool (Tooling Mandate). Test desktop (1280px) and mobile (375px).

After all fixes, run: npx tsc --noEmit && npm run lint && npm test && npm run lint:copy

Create a single commit on the branch, push, and create a PR against main with title "fix: UAT Sprint 6 — 8 medium+low polish bugs".

After PR is created, wait 10 minutes. Then review the PR and all its comments (use `gh pr view` and `gh api repos/carson-see/ArkovaCarson/pulls/{number}/comments`). Address any review feedback, push fixes, and update the PR.

Update CLAUDE.md Section 8 (mark BUG-UAT-10 through BUG-UAT-17 as RESOLVED), HANDOFF.md (session log + bug tracker), and MEMORY.md (session handoff notes, story status).
