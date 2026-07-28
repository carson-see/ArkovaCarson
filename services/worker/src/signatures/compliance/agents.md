# agents.md — services/worker/src/signatures/compliance/

_Last updated: 2026-07-28_

## What This Folder Contains

Compliance event emitters and audit proof export for the signatures subsystem.

| File | Purpose |
|------|---------|
| `complianceEvents.ts` | Compliance webhook event types and emitters (cert expiry, anchor delay, etc.) |
| `complianceEvents.test.ts` | Tests for compliance event emission |
| `auditProofExporter.ts` | Per-credential audit proof package generation (anchor proof, AdES details, timestamp, cert chain, eIDAS/ESIGN assessment) |
| `auditProofExporter.test.ts` | Org-scoping tests for `generateAuditProof` (SECURITY, see below) |

## 2026-07-28 SECURITY — generateAuditProof had no org scoping (fix)

**VULNERABILITY CLASS — do not reintroduce:** `generateAuditProof(signaturePublicId)` previously took only the signature's public id, with NO org scoping on the `signatures` query. Its only caller, `GET /api/v1/signatures/:id/audit-proof` in `api/v1/signatureCompliance.ts`, had **zero org check at all** — every other route in that file already used the correct `getCallerOrgId`/`isCallerOrgAdmin` pattern, but this one route was missed. Any authenticated user could pull any other org's signature audit proof (signer PII, certificate chain, eIDAS/ESIGN compliance data) by guessing/enumerating signature public ids.

**Fix:** `generateAuditProof` now takes a REQUIRED second `orgId` argument and scopes the query with `.eq('org_id', orgId)` in addition to `.eq('public_id', signaturePublicId)` — matching `bulkExportSignatures`' existing scoping pattern in this same file. A signature that exists but belongs to a different org resolves to `null` (→ 404 at the route), identical to a truly-missing signature, so no cross-org existence is ever confirmed to the caller. The route resolves `orgId` from the caller via `getCallerOrgId` (membership-only — same sensitivity class as the sibling `/signatures/export` route, not admin-gated) — never from client input.

**Pattern for any new function reading from `signatures` (or any other org-owned table) by a public/opaque id:** always take `orgId` as a required parameter and add it to the `.eq()` filter chain. Do not rely on the caller to have already checked org ownership — a query without an org filter is reachable by ANY authenticated caller regardless of what the route layer intended, and `db` is the service_role client (bypasses RLS by design, see `middleware/agents.md`).

## Do / Don't Rules

- **DO** emit compliance events through the existing webhook infrastructure (WEBHOOK-1 through WEBHOOK-4)
- **DO NOT** include raw document content in audit proof packages
- **DO NOT** add or change a query against an org-owned table without an explicit `org_id` filter derived from the authenticated caller (never from client input) — see the SECURITY note above
