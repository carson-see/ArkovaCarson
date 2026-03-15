# UAT Bug Fix Sprints — Sprint 5 & Sprint 6
_Last updated: 2026-03-15 | Source: UAT Bug Bounty Report_

## Overview

17 bugs discovered during comprehensive UAT testing on 2026-03-15. Split into two sprints by severity.

| Sprint | Focus | Bugs | Priority |
|--------|-------|------|----------|
| Sprint 5 | Critical + High fixes (launch blockers) | 9 | P0 + P1 |
| Sprint 6 | Medium + Low fixes (polish) | 8 | P2 + P3 |

**Bug report:** [docs/bugs/uat_2026_03_15.md](../bugs/uat_2026_03_15.md)

---

## Sprint 5: UAT Critical + High (Launch Blockers)
_Target: Complete before any user-facing launch_

### Sprint 5 Stories

| ID | Bug | Severity | Component | Estimated Effort | Dependencies |
|----|-----|----------|-----------|-----------------|--------------|
| UAT-S5-01 | BUG-UAT-01: Mobile sidebar auto-collapse | CRITICAL | Sidebar.tsx, AppShell.tsx | Medium | None |
| UAT-S5-02 | BUG-UAT-02: Console auth errors | CRITICAL | supabase.ts, Supabase config | Small | Supabase project access |
| UAT-S5-03 | BUG-UAT-03: Billing route inaccessible | CRITICAL | App.tsx, Sidebar.tsx, RouteGuard | Medium | None |
| UAT-S5-04 | BUG-UAT-04: Header always says "Dashboard" | HIGH | Header.tsx | Small | None |
| UAT-S5-05 | BUG-UAT-05: Help link dead end | HIGH | HelpPage.tsx, Sidebar.tsx | Small | None |
| UAT-S5-06 | BUG-UAT-06: Avatar dropdown does nothing | HIGH | Header.tsx | Small | None |
| UAT-S5-07 | BUG-UAT-07: Status badge overlaps date | HIGH | RecordsList.tsx | Small | None |
| UAT-S5-08 | BUG-UAT-08: Org records table missing columns | HIGH | OrgRegistryTable.tsx | Medium | None |
| UAT-S5-09 | BUG-UAT-09: Redundant profile API calls | HIGH | useProfile.ts | Medium | None |

### Sprint 5 Execution Order (dependency-sorted)

1. **UAT-S5-02** — Auth errors (investigate Supabase config, may be config-only fix)
2. **UAT-S5-04** — Header title (quick win, improves all page testing)
3. **UAT-S5-05** — Help link (quick win, remove or implement)
4. **UAT-S5-06** — Avatar dropdown (quick win, wire existing DropdownMenu)
5. **UAT-S5-07** — Status badge overlap (CSS fix)
6. **UAT-S5-01** — Mobile sidebar (responsive breakpoint logic)
7. **UAT-S5-03** — Billing route (route guard investigation + sidebar nav item)
8. **UAT-S5-08** — Org records table (add missing columns)
9. **UAT-S5-09** — Profile API redundancy (add React context/caching)

### Sprint 5 Acceptance Criteria

- [ ] No console errors on page load (auth errors suppressed or resolved)
- [ ] Header title dynamically reflects current page
- [ ] Help link either renders a page or is removed from sidebar
- [ ] Avatar dropdown shows menu with Profile, Settings, Sign Out
- [ ] Status badges and dates don't overlap on record cards
- [ ] Mobile viewport: sidebar collapsed by default, hamburger to expand
- [ ] `/billing` route renders PricingPage. "Billing" link in sidebar.
- [ ] Org records table shows Status, Date, Credential Type, Fingerprint columns
- [ ] Profile endpoint called maximum 1-2 times per page load (not 8+)
- [ ] All existing tests pass (`npm test`, `npm run lint`, `npm run lint:copy`)
- [ ] Playwright snapshot verification on all changed pages (desktop + mobile)

### Sprint 5 Files to Modify

| File | Changes |
|------|---------|
| `src/components/layout/Sidebar.tsx` | Add mobile breakpoint detection, default collapsed on mobile, add Billing nav item |
| `src/components/layout/AppShell.tsx` | Pass mobile state to sidebar |
| `src/components/layout/Header.tsx` | Dynamic page title from route, wire avatar dropdown menu |
| `src/lib/supabase.ts` | Investigate/suppress oauth_client_id error |
| `src/App.tsx` | Check billing route guard conditions |
| `src/pages/HelpPage.tsx` | Add content or redirect to docs |
| `src/components/records/RecordsList.tsx` | Fix badge/date layout overlap |
| `src/components/organization/OrgRegistryTable.tsx` | Add Status, Date, Type, Fingerprint columns |
| `src/hooks/useProfile.ts` | Add caching (React context or dedup) |

---

## Sprint 6: UAT Medium + Low (Polish)
_Target: Complete before marketing launch or first external demo_

### Sprint 6 Stories

| ID | Bug | Severity | Component | Estimated Effort | Dependencies |
|----|-----|----------|-----------|-----------------|--------------|
| UAT-S6-01 | BUG-UAT-10: Secure Document button overlaps subtitle | MEDIUM | MyRecordsPage.tsx | Small | None |
| UAT-S6-02 | BUG-UAT-11: Stat cards stacked vertically on desktop | MEDIUM | DashboardPage.tsx, StatCard.tsx | Small | None |
| UAT-S6-03 | BUG-UAT-12: Tablet viewport clips content | MEDIUM | AppShell.tsx, layout styles | Small | UAT-S5-01 (mobile fix may resolve) |
| UAT-S6-04 | BUG-UAT-13: Account Type dual labels confusing | MEDIUM | DashboardPage.tsx | Small | None |
| UAT-S6-05 | BUG-UAT-14: Seed data visible (pre-launch strip) | MEDIUM | supabase/seed.sql | Small | Pre-launch checklist |
| UAT-S6-06 | BUG-UAT-15: No "Forgot Password" link | LOW | LoginForm.tsx | Small | None |
| UAT-S6-07 | BUG-UAT-16: No loading states | LOW | Various hooks/pages | Medium | None |
| UAT-S6-08 | BUG-UAT-17: QR code URL shows localhost | LOW | AssetDetailView.tsx | Small | Production env var |

### Sprint 6 Execution Order

1. **UAT-S6-02** — Stat cards layout (quick CSS fix, high visual impact)
2. **UAT-S6-01** — Secure Document button overlap (layout fix)
3. **UAT-S6-04** — Account Type labels (copy/layout fix)
4. **UAT-S6-03** — Tablet clipping (may be resolved by Sprint 5 mobile work)
5. **UAT-S6-06** — Forgot Password link (add Supabase `resetPasswordForEmail`)
6. **UAT-S6-08** — QR code URL (env var check)
7. **UAT-S6-07** — Loading states (add Skeleton components to key pages)
8. **UAT-S6-05** — Seed data strip (pre-launch only)

### Sprint 6 Acceptance Criteria

- [ ] Stat cards display horizontally on desktop (3-column grid)
- [ ] "Secure Document" button doesn't overlap subtitle text
- [ ] Account Type section shows only the user's actual role clearly
- [ ] Tablet viewport shows all content without clipping
- [ ] "Forgot Password?" link on login page, wired to Supabase
- [ ] QR code URL uses `VITE_APP_URL` env var (not localhost)
- [ ] Key pages show skeleton/shimmer loading states during data fetch
- [ ] Seed data stripped or flagged for production strip
- [ ] All existing tests pass
- [ ] Playwright verification on changed pages

### Sprint 6 Files to Modify

| File | Changes |
|------|---------|
| `src/pages/DashboardPage.tsx` | Fix stat card grid, fix Account Type labels |
| `src/components/dashboard/StatCard.tsx` | Responsive grid classes |
| `src/pages/MyRecordsPage.tsx` | Fix button/subtitle layout |
| `src/components/layout/AppShell.tsx` | Tablet overflow fix |
| `src/components/auth/LoginForm.tsx` | Add Forgot Password link |
| `src/components/anchor/AssetDetailView.tsx` | Use env var for QR URL |
| Various page components | Add Skeleton loading states |
| `supabase/seed.sql` | Strip demo data (pre-launch only) |

---

## Cross-Sprint Notes

### Testing Requirements
Both sprints must:
- Keep all existing tests green (`typecheck`, `lint`, `test`, `lint:copy`)
- Use Playwright MCP tool to verify visual changes (Tooling Mandate)
- Test across desktop (1280px), tablet (768px), and mobile (375px)
- No regressions on public verification page (most polished page)

### Not In Scope
- P4.5 Verification API (post-launch)
- P8 AI Intelligence (separate track)
- CRIT-2 operational items (AWS KMS, mainnet funding — infrastructure, not UI)
- New features — these sprints are bug-fix-only
