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
