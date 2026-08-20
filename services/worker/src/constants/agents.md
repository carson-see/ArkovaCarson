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


## 2026-08-15 BUG-2026-08-13-010 — `connectorFingerprint.ts`

- Single source for the `fetch_time_snapshot` re-derivability class, its §1.5 measured / asserted / NOT-asserted note, and the closed `metadata.connector_source` marker set (`docusign` / `google_drive` / `microsoft_365` / `connector`; deliberately EXCLUDES `manual_upload` / `batch_upload` — user-supplied bytes ARE reproducible from the retained file).
- Soak-proven finding: four fetches of the same unchanged DocuSign envelope produced four different SHA-256s — connector fingerprints attest fetch-time bytes, NOT source re-derivability. Emitted by `/api/v1/verify/:publicId`, `/api/v1/verify/:publicId/proof` (response level, never inside the signable `proof_bundle`), and the `/api/proof-packet` anchor receipt.
- Same rules as `proofAvailability.ts` directly above: the note is public API response copy with legal weight, drafted by engineering, NOT counsel-reviewed, rendered verbatim from this one export, and MUST stay vendor-neutral (the marker is org-writable on legacy paths — `bulk_create_anchors` persists client metadata verbatim — so a fixed generic statement is the only shape that cannot be laundered into a vendor provenance claim, R-7). A reword requires a `verifyCache.ts` `KEY_PREFIX` bump (v6 as of this entry).
- The class+note pair is produced ONLY by `connectorFingerprintRederivabilityFields()` — indivisible by construction, same §1.5 rationale as `proofAvailabilityFields`.
