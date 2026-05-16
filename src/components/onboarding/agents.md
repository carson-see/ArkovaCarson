# agents.md — components/onboarding
_Last updated: 2026-05-16_

## What This Folder Contains
User onboarding flow components: stepper, org setup, plan selection, role selection, checklist, and disclaimers.

## Key Files
- `OnboardingStepper.tsx` — Visual progress indicator with numbered steps (active/completed/upcoming states)
- `OrgOnboardingForm.tsx` — Organization creation form during onboarding
- `OrgMembershipQuestion.tsx` — "Create or join an org?" decision step
- `PlanSelector.tsx` — Subscription plan picker during onboarding
- `RoleSelector.tsx` — User role selection step
- `GettingStartedChecklist.tsx` — Role-specific post-onboarding checklist on dashboard, persisted to localStorage
- `DisclaimerStep.tsx` — Legal disclaimer acknowledgment step
- `EmailConfirmation.tsx` — Email verification confirmation screen
- `ManualReviewGate.tsx` — Gate for accounts requiring manual review before activation
- `RecoveryPhraseModal.tsx` — Recovery phrase display during onboarding
- `index.ts` — Barrel exports

## Dependencies
- `@/lib/copy` (ONBOARDING_LABELS, ONBOARDING_GUIDANCE_LABELS) — all UI strings
- `@/lib/routes` (ROUTES) — navigation targets from checklist items
