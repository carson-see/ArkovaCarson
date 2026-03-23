# UX Overhaul — Product Requirements Document

**Author:** Session 9 | **Date:** 2026-03-23 | **Priority:** HIGH
**Current UX Rating:** 6.5/10 (solid engineering, UX refinement needed for GA)

---

## Problem Statement

The Arkova app is architecturally sound but suffers from UX fragmentation:
- **Dashboard cognitive overload**: 8+ sections crammed into one page (stats, usage, credits, CLE, checklist, privacy, records, account)
- **No clear user journey**: New users land on a dashboard full of empty widgets with no guidance
- **Status terminology confusion**: PENDING/SUBMITTED/SECURED lack context for non-technical users
- **Feature discoverability**: Key features (Attestations, Search, API keys) hidden in sidebar
- **Mobile UX gaps**: Touch targets too small, layouts not optimized for 375px
- **Redundant information**: Account info on dashboard duplicates Settings page
- **Inconsistent patterns**: Different status badge colors across pages

## Competitor Analysis

### Best-in-Class Patterns (from Accredible, Credly, Certifier):
1. **Clean dashboard**: Single primary metric + recent activity feed (not 8 widget sections)
2. **Progressive disclosure**: Show complexity only when needed
3. **Action-first design**: Primary CTA always visible (Upload, Issue, Verify)
4. **Clear status language**: "Verified", "Processing", "Needs Attention" (not DB enum names)
5. **Guided onboarding**: Step-by-step wizard, not a checklist buried in dashboard

---

## Phase 1: Dashboard Simplification (Session 9)

### P1.1 — Remove redundant sections from Dashboard
- **Remove**: Account info card (already on Settings page)
- **Remove**: Privacy toggle (move to Settings page)
- **Collapse**: Getting Started checklist → dismissible banner, not always-visible section
- **Conditional**: CLE widget only shows if user has CLE records

### P1.2 — Cleaner stat cards
- Keep 4 stats but add tooltips explaining what each means
- Add status icons with color-coded meaning

### P1.3 — Prominent primary CTA
- "Secure Document" button should be more visually prominent
- Add it as a hero-style CTA when user has 0 records (not just an EmptyState button)

---

## Phase 2: Status Clarity (Session 9)

### P2.1 — Human-readable status labels
| Internal | Display | Tooltip |
|----------|---------|---------|
| PENDING | Processing | Your document is being anchored to the network |
| SUBMITTED | Submitted | Awaiting network confirmation |
| SECURED | Verified | Permanently anchored and independently verifiable |
| REVOKED | Revoked | This record has been revoked by the issuer |
| EXPIRED | Expired | This record's validity period has ended |

### P2.2 — Status explanations
- Add info icon next to each status badge with tooltip
- RecordDetail page: show timeline of status changes

---

## Phase 3: Navigation & Discovery (Future)

### P3.1 — Breadcrumb navigation
- All detail pages: Dashboard > Records > [Record Name]
- Org pages: Organizations > [Org Name] > Members

### P3.2 — Feature highlights
- Add subtle badges to new/unused features in sidebar
- Periodic tips in dashboard for undiscovered features

---

## Phase 4: Mobile UX (Future)

### P4.1 — Touch target audit
- All buttons minimum 44x44px touch target
- Dropdown triggers larger on mobile

### P4.2 — Responsive layouts
- Stats: 2x2 grid on mobile (not 1x4)
- Records list: card view on mobile, table on desktop

---

## Implementation Priority

| Change | Effort | Impact | Priority |
|--------|--------|--------|----------|
| Remove account card from dashboard | 5 min | Medium | P1 |
| Move privacy toggle to settings | 15 min | Medium | P1 |
| Make Getting Started dismissible | 30 min | High | P1 |
| Human-readable status labels | 30 min | High | P1 |
| Status tooltips | 20 min | Medium | P1 |
| Conditional CLE widget | 10 min | Low | P2 |
| Breadcrumbs | 1 hr | Medium | P3 |
| Mobile touch targets | 2 hr | High | P4 |

---

## Acceptance Criteria

- [ ] Dashboard has max 5 visual sections (stats, usage/credits row, records list, and optionally getting-started + CLE)
- [ ] Status labels use human-readable names everywhere
- [ ] Each status badge has a tooltip explaining what it means
- [ ] Getting Started checklist is dismissible and remembers dismissal
- [ ] Account info and privacy toggle live only in Settings
- [ ] No regressions: all 974 tests pass
- [ ] UAT: desktop (1280px) and mobile (375px) screenshots confirm changes
