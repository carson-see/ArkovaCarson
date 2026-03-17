# Continuation Prompt — UF Sprint C

> Copy-paste this into your next Claude Code session to continue where we left off.

---

## Context

I'm building Arkova, a credentialing MVP. Read `CLAUDE.md` (rules + story status), `MEMORY.md` (living state), and `docs/stories/14_user_flow_gaps.md` (UF stories).

## What's Done

**Sprint A COMPLETE** (PR #60): UF-01 (CredentialRenderer) + UF-04 (PENDING status UX)
**Sprint B COMPLETE** (PR #61): UF-02 (public search) + UF-05 (metadata entry) + UF-06 (usage dashboard) + UF-07 (enhanced verification)

- 556 frontend tests + 604 worker tests = 1,160 total
- 55 migrations (0001-0055), all applied to production Supabase
- 105/151 stories complete (~70%)
- No open PRs, no stale branches, main is clean

## What's Next — Sprint C

Start Sprint C of the User Flow Gap stories:

### 1. UF-03: Individual Recipient Credential Inbox (HIGH)
**Depends on:** P5-TS-05 (DONE)

Recipients have no way to view credentials issued to them. Need:
- New `anchor_recipients` table (migration 0056) linking anchors to recipient emails
- `/my-credentials` authenticated route showing credentials issued to the logged-in user
- Recipient notification on credential issuance
- Schema-first per Constitution 1.2 — migration before UI

### 2. UF-08: Post-Issuance Actions + Share Flow (MEDIUM)

After issuing a credential, org admins need:
- Copy verification link button
- Share sheet (email, LinkedIn)
- Email notification to recipient

### 3. UF-09: Org Context + Navigation Polish (MEDIUM)

- Breadcrumbs in AppShell
- Org name in header
- Auth redirect toast ("Please sign in to access...")

### 4. UF-10: Onboarding Completion + Empty State Guidance (MEDIUM)

- Getting started checklist on Dashboard
- First-credential wizard for new orgs
- Empty state improvements across pages

## Rules Reminder

- Don't commit code — put everything in a PR for review
- Follow Nordic Vault design system (glass-card, shadow-card-rest/hover, animate-in-view, DM Sans + JetBrains Mono)
- All UI strings in `src/lib/copy.ts`
- All DB writes validated with Zod
- UAT mandate: Playwright screenshots at desktop (1280px) + mobile (375px) for all UI changes

## Remaining Ops (manual, not code)

1. AWS KMS key provisioning (mainnet signing)
2. Mainnet treasury funding
3. Sentry DSN env vars (Vercel + GCP)
4. Key rotation (Stripe + Supabase service role)
5. Seed data strip before public launch
