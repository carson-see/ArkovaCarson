# services/worker/scripts/intelligence-dataset/scenarios/hipaa

HIPAA training scenarios for healthcare credentialing, employment verification, and HIPAA-FCRA intersection.

## Files

- `credential-verification.ts` — Credential-verification-specific scenarios: privacy-rule, business-associate, security-rule, breach-rule fact patterns in healthcare credentialing contexts.
- `privacy-and-patient-rights.ts` — Foundational Privacy Rule and patient-rights scenarios.
- `security-breach-ba.ts` — Security Rule, Breach Notification Rule, and business-associate scenarios.
- `v28-1-expansion.ts` — v28.1 scenario expansion for broader HIPAA coverage.

## Constraints

- All citations must use canonical IDs from `sources/hipaa-sources.ts`.
