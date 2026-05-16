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
