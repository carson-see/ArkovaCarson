# FD-GATE-1 — §1.9's kill switch does not cover all of `/api/v1/*`

**Found 2026-08-20 while diagnosing why a fresh soak rig returned 503 on `POST /api/v1/keys`.
CLAUDE.md §1.9 states: "`ENABLE_VERIFICATION_API` controls `/api/v1/*`." That is not what the
code does.**

## What the code actually does

`services/worker/src/index.ts` mounts three route trees under `/api/v1/` **before** the
catch-all, each WITHOUT `verificationApiGate()`:

| Line | Mount | Gated by ENABLE_VERIFICATION_API? |
|---|---|---|
| 470 | `/api/v1/org` (orgVerification) | **NO** |
| 471 | `/api/v1/org/sub-orgs` (orgSubOrgs) | **NO** |
| 472 | `/api/v1/org-kyb` (orgKyb) | **NO** |
| 517 | `/api/v1/rules/templates` | yes |
| 533-536 | `/api/v1` catch-all (`apiV1Router`) | yes |

All three ungated mounts do carry `requireAuthMw`, so this is **not an unauthenticated hole**.
The gap is in the kill switch, not in authentication.

## Why it matters

1. **Incident response.** If the v1 surface ever needs darkening, flipping
   `ENABLE_VERIFICATION_API` off leaves org verification, sub-org management, and KYB
   endpoints serving. An operator acting on §1.9's wording would believe the surface was
   fully dark when three route trees are still up. A kill switch that silently covers less
   than its documentation claims is worse than no kill switch, because it is trusted.
2. **Fresh-environment posture is inconsistent.** On a new rig with an empty
   `switchboard_flags` table the flag fails closed, so most of `/api/v1` is dark while these
   three are live. That is how this was found: `POST /api/v1/keys` returned 503 on the Wave 2
   rig while `/api/v1/org/*` served normally.

## The open question — code bug or doc bug?

Both readings are defensible and this should NOT be "fixed" by reflex:

- **If the constitution is right**, these three should be gated, and the fix is three
  `verificationApiGate()` insertions.
- **If the code is right**, the exemption may be deliberate: darkening the public
  verification API while leaving customers able to manage their own organisation is a
  reasonable incident posture. In that case §1.9 is what needs correcting, to state the
  actual coverage and the reason for the carve-out.

Nothing in the code comments states an intent either way, which is itself the defect —
whichever behaviour is intended, it is currently undocumented and therefore accidental.

## Evidence

Verified by reading the live mount order in `index.ts`, and empirically on the Wave 2 rig
(`tkciooifwxwnkoizgalp`) where an empty switchboard produced 503 on the gated catch-all and
200s on `/api/v1/org/*` in the same session. No production change was made.
