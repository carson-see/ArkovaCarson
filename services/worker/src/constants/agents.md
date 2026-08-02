# services/worker/src/constants/

Shared constant definitions used across the worker. Single source of truth for enum values, vendor identifiers, and route paths.

## Files

- **connectors.ts** — Vendor string constants for rule events (`GOOGLE_DRIVE_VENDOR`, `SHAREPOINT_VENDOR`, `DOCUSIGN_VENDOR`, etc.). Type-checked to prevent typo-class bugs.
- **ferpa.ts** — FERPA compliance enums: party types, disclosure exception categories, institution types, education credential types. Used by keys, disclosures, and verify modules.
- **hipaa.ts** — HIPAA compliance constants: healthcare credential types triggering HIPAA controls, emergency access max duration.
- **webhook-paths.ts** — Single source of truth for public webhook paths. Both provider registration and worker mount derive from these constants to prevent silent 404 drift.
- **webhook-paths.test.ts** — Tests for webhook path constants and the `relativeTo()` helper.

## Rules

- Vendor strings are canonical here — other files re-export for backward compat but this is the source of truth.
- Mismatched vendor literals are fail-closed by `evaluateRules`, so correctness matters.

## 2026-08-01 SCRUM-2575/2576 — `proofAvailability.ts`

- Single source for the `per_document` / `root_only` vocabulary and the measured / asserted / NOT-asserted note text served by `/api/v1/verify/:publicId` and the `/proof` `NO_BATCH_PROOF` 404.
- The note text is **public API response copy with legal weight** (Constitution 1.5 / R-7). It is drafted by engineering and NOT yet counsel-reviewed. Both failure modes are claims problems: `root_only` must never read as "this record is unverifiable" (it is anchored and checkable against the chain), and must never read as "you can verify this offline from a bundle we gave you" (we did not give you one).
- Reword in this file only — every surface renders it verbatim from this export. A reword also requires a `verifyCache.ts` `KEY_PREFIX` bump, because the note is baked into the cached verify payload.
- Deliberately NOT the internal classifier vocabulary (`already_complete` / `direct_anchored` / `batch_provable` / `ambiguous` in `jobs/proof-backcatalog-classifier.ts`). That describes an operational census; this describes the one thing a caller can act on.

