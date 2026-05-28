# services/worker/src/api/v1/verify/agents.md

_Last updated: 2026-05-27_

## What This Folder Contains

Public verification sub-endpoints mounted under `/api/v1/verify/`. These are publicly accessible, anonymous-allowed endpoints for verifying different record types.

| File | Purpose |
|------|---------|
| `attestation.ts` | SCRUM-1873: `GET /api/v1/verify/attestation/:attestationId` — public verification of legally binding attestations (table `legally_binding_attestations`). Returns verification status, attestation metadata, anchor proof, and notarization status. |
| `attestation.test.ts` | 15 unit tests for `buildAttestationVerificationResult` covering anchored/draft/pending/notarized states, terminology compliance, UUID leak prevention, and privacy guards. |

## Do / Don't Rules

- **DO** use `buildAttestationVerificationResult()` for all response construction — it is the explicit-allowlist guard that prevents field leaks.
- **DO NOT** include `attestation_statement` in any public response — migration 0314 COMMENT marks it private.
- **DO NOT** expose internal UUIDs (`id`, `attesting_org_id`, `anchor_id`) — use public_id fields only.
- **DO NOT** use banned terminology in response keys (hash, transaction, blockchain, bitcoin, wallet, crypto) per CLAUDE.md 1.3.

## Architecture Decisions

- **Separate from attestations.ts**: The general `GET /api/v1/attestations/:publicId` handles the `attestations` table (general attestations). This endpoint handles the `legally_binding_attestations` table (DocuSign notarization chain from SCRUM-1871/1872).
- **Injectable lookup**: `AttestationLookup` interface allows test injection via `req._testLookup`, same pattern as `verify.ts`.
- **Route ordering**: Mounted at `/verify/attestation` BEFORE the generic `/verify` catch-all in router.ts to avoid shadowing.
