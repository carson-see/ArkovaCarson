# services/worker/src/api/v1/verify/agents.md

_Last updated: 2026-08-30_

## What This Folder Contains

Public verification sub-endpoints mounted under `/api/v1/verify/`. These are publicly accessible, anonymous-allowed endpoints for verifying different record types.

| File | Purpose |
|------|---------|
| `attestation.ts` | SCRUM-1873: `GET /api/v1/verify/attestation/:attestationId` — public verification of legally binding attestations (table `legally_binding_attestations`). Returns verification status, attestation metadata, anchor proof, and notarization status. |
| `attestation.test.ts` | 38 tests: the `buildAttestationVerificationResult` shape contract, the `isPubliclyDisclosable` status gate, route-level status/ID/audit behaviour driven over a real ephemeral HTTP server, and the `defaultLookup` query shape. |

## Do / Don't Rules

- **DO** use `buildAttestationVerificationResult()` for all response construction — it is the explicit-allowlist guard that prevents field leaks.
- **DO** gate every disclosure on `isPubliclyDisclosable()`. Migration 0314 grants no anon `SELECT` and ships no `..._select_public_anchored` policy (both absences pinned by `src/tests/legal-attestations-migration.test.ts`); its table COMMENT requires public verification to be "API-mediated and **redacted**". This module is the mediation; the status gate is the redaction.
- **DO NOT** include `attestation_statement` in any public response — migration 0314 COMMENT marks it private.
- **DO NOT** expose internal UUIDs (`id`, `attesting_org_id`, `anchor_id`) — use public_id fields only.
- **DO NOT** use banned terminology in response keys (hash, transaction, blockchain, bitcoin, wallet, crypto) per CLAUDE.md 1.3.
- **DO NOT** widen the `^ARK-ATT-` id pattern. `attestations` public_ids (`ARK-{org_prefix}-{type_code}-{unique}`, e.g. `ARK-ARK-VER-196485`) are valid ids for a *different* resource; a 400 naming the expected prefix routes the caller to `GET /api/v1/attestations/:publicId`. Widening only turns that into an unresolvable 404.
- **DO NOT** report a failed lookup as a 404. `defaultLookup` throws on a query error so the route 500s; collapsing error into not-found hides timeouts and RLS denials (see `memory/project_hollow_200_statement_timeout_swallow.md`).
- **DO NOT** write an audit row on a 400/404. The endpoint is anonymous, so auditing misses would let a caller append unbounded `audit_events` rows by walking id space.

## Architecture Decisions

- **Separate from attestations.ts**: The general `GET /api/v1/attestations/:publicId` handles the `attestations` table (general attestations). This endpoint handles the `legally_binding_attestations` table (DocuSign notarization chain from SCRUM-1871/1872). The two ID namespaces overlap only by accident and must not be merged.
- **Disclosure gate**: only `notarized` and `anchored` rows are disclosable. `draft` / `pending_notarization` / `requires_review` carry `subject_name` plus notary commission details for work the org has not published, and are withheld with the same 404 body as a missing row so the endpoint is not an existence oracle. The filter is applied in SQL *and* re-checked in the route.
- **Feature state**: `legally_binding_attestations` is a real but *incomplete* feature — 0 prod rows. `docusign-notarization-completed.ts` updates rows and this endpoint plus `NotarizationBadge.tsx` read them, but **nothing INSERTs a row anywhere in the codebase**. The creation path (draft → pending_notarization) is unbuilt. Do not "fix" the empty endpoint by repointing it at `attestations`.
- **Injectable lookup**: `AttestationLookup` interface allows test injection via `req._testLookup`, same pattern as `verify.ts`.
- **Route ordering**: Mounted at `/verify/attestation` BEFORE the generic `/verify` catch-all in router.ts to avoid shadowing.
- **Tests avoid `supertest`**: it is a worker-only devDependency that does not resolve from a git worktree, so route tests use `express` + `node:http` + built-in `fetch`.
