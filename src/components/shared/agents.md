# agents.md — components/shared
_Last updated: 2026-05-16_

## What This Folder Contains
Reusable cross-cutting components used across multiple feature areas.

## Key Files
- `OrgAvatar.tsx` — Organization logo with two-letter initials fallback (sm/md/lg sizes)
- `VerifiedBadge.tsx` — Verified badges for users, organizations, and anchor trust labels (per IDT spec, trust signal varies by source type)
- `OrgRequiredCard.tsx` — Card prompting user to create/join an org
- `PublicFooter.tsx` — Shared footer for public-facing GEO pages (How It Works, Use Cases, Enterprise)
- `SocialIcons.tsx` — Social media icon links

## Do / Don't Rules
- DO: Source all footer copy from `PUBLIC_FOOTER_LABELS` per Constitution 1.3
- DO: Use `VerifiedBadge` variants appropriate to the entity type (user vs. org vs. anchor)
## 2026-09-21 — Signed-URL retry is bounded (PR #3033 review)

`useProfileMediaUrl` backs off exponentially (5s doubling to a 60s ceiling),
stops after six consecutive failures, stops IMMEDIATELY on a permission-style
Storage status (400/401/403/404 — waiting cannot make that object signable),
and signs nothing while the tab is hidden, re-signing on `visibilitychange`.
The healthy 25-second refresh inside the 30-second lease is unchanged. Do not
restore an unconditional fixed-interval retry: an unsignable object otherwise
polls Storage forever, once per image.

## 2026-09-26 — Signed-URL retry recovers on a signal instead of latching permanently (P2 review follow-up)

The 2026-09-21 bounded-retry design above had a gap: once stopped (either
six consecutive transport/server failures, or an immediate permission-style
denial), NOTHING could resume it short of a remount — `schedule()` refused to
arm a timer while stopped, and the `visibilitychange` handler called `sign()`
directly, which itself refused to run while stopped. There was also no
`online` listener at all. Reproduced: six offline failures, then a
subsequently-successful signing mock, then an `online` event, then a
visible-tab event — no recovery.

Fixed by tracking WHY signing stopped (`stopReason: 'exhausted' | 'terminal' |
null`) and gating recovery accordingly through a single `recover(allowedReasons)`
helper:
- `'exhausted'` (bounded retries ran out) resumes on `online` OR the tab
  becoming visible — the outage that exhausted retries may simply be over.
- `'terminal'` (permission-style denial — the viewer isn't allowed to read
  this object right now) does NOT resume on `online`/visibility — that would
  be continuous unauthorized polling against Storage — but DOES resume on a
  `supabase.auth.onAuthStateChange` event (sign-in, MFA step-up, token
  refresh), since a session/AAL change is exactly the kind of event that can
  make a previously-forbidden object signable.

The auth subscription is read with optional chaining
(`supabase.auth?.onAuthStateChange?.(...)`) so a test harness's minimal
`supabase` mock (storage-only, no `auth` — `Header.test.tsx`,
`ProfileCard.test.tsx`) degrades to "no auth-driven recovery" rather than
throwing; production `supabase` always has `.auth`, so this changes nothing
for real usage.

Do not revert to gating `sign()` itself on a stopped flag — recovery is now
the caller's decision (`recover()`), not something baked into `sign()`.
