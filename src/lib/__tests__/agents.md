# agents.md — lib/__tests__
_Last updated: 2026-05-16_

## What This Folder Contains

Unit tests for `src/lib/` modules that live outside their co-located `.test.ts` siblings. Currently contains one file.

## Key Files
- `credentialSubTypes.test.ts` — validates the credential sub-type taxonomy (GRE-01): every type has sub-types, no duplicates, snake_case format, copy.ts has display labels for all, and the migration seed matches the TypeScript enum

## Do / Don't Rules
- DO: Add tests here only when the test spans multiple lib modules (cross-cutting); prefer co-located `.test.ts` files next to the source
- DON'T: Import real Stripe or Bitcoin APIs — mock interfaces only
