# SCRUM-952 Public Verification UAT

**Date:** 2026-05-15  
**Tester:** Codex automated UAT with Playwright  
**PR:** https://github.com/carson-see/ArkovaCarson/pull/784  
**Branch:** `codex/scrum-952-public-verify-contract` with in-branch review/UAT follow-up changes  
**Target:** local Vite serving this PR branch against staging Supabase `ujtlwnoqfhtitcmsnrpq`

## Scope

This UAT covers the public `/verify/:publicId` hero state machine required by SCRUM-952:

- `PENDING`
- `SUBMITTED`
- `SECURED`
- `EXPIRED`
- `REVOKED`

The screenshots also exercise the subtype-label fallback by seeding `metadata.sub_type = professional_certification`, which must render as `Professional Certification` rather than the generic `Other` fallback.

## Result

PASS.

- No green verified affordance appears for `PENDING` or `SUBMITTED`.
- `SUBMITTED` shows the amber clock and awaiting-confirmation copy.
- `SECURED` shows the green secured affordance and proof sections.
- `EXPIRED` and `REVOKED` preserve terminal proof/evidence affordances without claiming an active good standing state.
- The credential Type label renders as `Professional Certification`.
- Mobile 375px layout was checked after fixing the credential-card header so the type/status area no longer collapses into stacked letters.

## Commands

```sh
UAT_BASE_URL=http://127.0.0.1:5173 npx tsx scripts/uat/capture-scrum-952-public-verify.ts
```

The script uses staging Supabase credentials from managed secrets, creates synthetic anchors, captures screenshots, then deletes the anchors.

## Artifacts

| Viewport | PENDING | SUBMITTED | SECURED | EXPIRED | REVOKED |
| --- | --- | --- | --- | --- | --- |
| 1280px desktop | `desktop-1280-pending.png` | `desktop-1280-submitted.png` | `desktop-1280-secured.png` | `desktop-1280-expired.png` | `desktop-1280-revoked.png` |
| 375px mobile | `mobile-375-pending.png` | `mobile-375-submitted.png` | `mobile-375-secured.png` | `mobile-375-expired.png` | `mobile-375-revoked.png` |

## Notes

Vercel previews for this PR were deployed successfully, but direct anonymous fetches returned Vercel SSO protection. This UAT therefore used the same PR code locally with staging Supabase data, which is the relevant public verification data contract for SCRUM-952.
