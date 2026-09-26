# agents.md — components/dashboard
_Last updated: 2026-09-12_

## 2026-09-12 SCRUM-4989 — `ProfileCard.tsx` social links go through `resolveSocialLinks`

`parseSocialLinks` used to cast `profile.social_links` to `Record<string,string>` and put the raw value straight into `href`, so a stored `javascript:` value was a clickable link (self-XSS — this card renders the viewer's own profile, from `DashboardPage`). It now resolves through `resolveSocialLinks` in `src/lib/socialLinks.ts`; anything unsafe is absent and renders as no link. `linkedin` + `twitter` are the only keys this card has ever rendered (`github`/`website` appear on the public profile page) — pre-existing scope, not a regression. `ProfileCard.test.tsx` pins the no-link outcome for pre-existing hostile values; keep that matrix if you touch the card.

## What This Folder Contains
Main dashboard widgets: stats, profile card, credit usage, empty states, and batch AI processing status.

## Key Files
- `StatCard.tsx` — Reusable metric card with label, value, icon, and optional trend indicator
- `ProfileCard.tsx` — User profile section: avatar, name, public ID, verified badge, privacy toggle, org link, social links
- `CreditUsageWidget.tsx` — Credit balance and usage cycle info via `useCredits()` hook
- `CleCreditWidget.tsx` — CLE-specific credit display widget
- `EmptyState.tsx` — Friendly empty state with optional action button
- `BatchAIDashboard.tsx` — Batch AI processing job status, progress, and results (gated behind ENABLE_AI_EXTRACTION)
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useCredits` — credit balance data
- `@/lib/supabase` — for BatchAIDashboard direct queries

## Do / Don't Rules
- DO: Use `useCredits()` hook for credit data, not direct Supabase queries
- DO: Gate AI features behind `ENABLE_AI_EXTRACTION` flag
## 2026-09-21 — ProfileCard avatar source (PR #3033 review)

The avatar resolves `avatar_storage_path` through `useProfileMediaUrl` with
`avatar_url` as the legacy fallback; UAT-14 uploads write only the storage
path. The hook call sits ABOVE the loading early-return (hook order). A denied
signature degrades to initials, with no retry storm.

## 2026-09-25 — the avatar "Change profile picture" control was removed

`ProfileCard` rendered a hover-revealed button over the avatar, correctly
labelled `aria-label="Change profile picture"`, whose `onClick` body was an empty
`// TODO: avatar upload`. Nothing in the product writes `profiles.avatar_url` —
there is no upload control and no settings field; `useProfile.updateProfile`
merely accepts the column. So it was a fully accessible affordance for a feature
that does not exist, and it shipped on every user's dashboard.

Removed rather than faked. `ProfileCard.test.tsx` now asserts the control is
absent. **If avatar upload ships, replace that assertion** rather than deleting
it — a TODO-bodied handler behind a real-looking control is the failure mode.
