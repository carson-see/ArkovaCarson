# agents.md — services/worker/src/signatures/compliance/

_Last updated: 2026-09-25 (complianceEvents.ts removed — see the dated entry below)_

## What This Folder Contains

Compliance event emitters and audit proof export for the signatures subsystem.

(As of 2026-09-25 only the audit proof export remains; the compliance event emitters were removed — see the dated entry below. The sentence above and the two inventory rows for the removed files are kept verbatim because `agents.md` is append-only: `scripts/ci/check-agents-md-append-only.ts`.)

| File | Purpose |
|------|---------|
| `auditProofExporter.ts` | Per-credential audit proof package generation (anchor proof, AdES details, timestamp, cert chain, eIDAS/ESIGN assessment) |
| `auditProofExporter.test.ts` | Org-scoping tests for `generateAuditProof` (SECURITY, see below) |
| `complianceEvents.ts` | Compliance webhook event types and emitters (cert expiry, anchor delay, etc.) |
| `complianceEvents.test.ts` | Tests for compliance event emission |

_The two rows above describe files deleted on 2026-09-25 (dead, validation-bypassing duplicates of `webhooks/compliance.ts`); they stay listed only to satisfy the append-only rule._

## 2026-09-25 — `complianceEvents.ts` / `complianceEvents.test.ts` removed (webhook event type divergence fix)

This folder used to also contain `complianceEvents.ts` (COMP-08): a `COMPLIANCE_EVENT_TYPES`
type union, event builders (`checkCertificateExpiry`, `checkAnchorDelays`,
`buildSignatureRevokedEvent`), and `fireComplianceEvents`, which wrote rows directly into
`webhook_delivery_logs` — bypassing `dispatchWebhookEvent` and therefore
`validateWebhookPayload` entirely.

**It was dead code.** A full-repo grep for its exports (`runComplianceChecks`,
`checkCertificateExpiry`, `checkAnchorDelays`, `emitSignatureRevoked`, `fireComplianceEvents`)
found zero production importers — no cron route in `routes/cron.ts`, no scheduler config,
nothing. It was a fully orphaned duplicate of the real, validated implementation in
`services/worker/src/webhooks/compliance.ts` (same COMP-08 ticket, same event families, built
on `dispatchWebhookEvent` + a registered `.strict()` schema per event — see that file and
`webhooks/agents.md`), minus one event type that implementation never grew
(`compliance.certificate_expired`, the terminal past-due alert — the real system only ever
implemented the advance `compliance.certificate_expiring` warning).

Two of the six `COMPLIANCE_EVENT_TYPES` entries were the actual bug this deletion fixes:

- `compliance.certificate_expired` — genuinely constructed (by `checkCertificateExpiry` in
  this now-deleted file) with an `event_type` destined for an unchecked
  `webhook_delivery_logs` insert, but absent from
  `webhooks/payload-schemas.ts`'s `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` — unreachable by any
  CRUD subscription and unvalidated at the (bypassed) dispatch layer regardless.
- `compliance.score_degraded` — NOT genuinely emitted anywhere. It existed only as a type-union
  member and a test assertion (`complianceEvents.test.ts` asserted `COMPLIANCE_EVENT_TYPES`
  "has exactly 6" entries); no function in the codebase ever constructed an event with this
  type. Confirmed by running `scripts/ci/check-webhook-event-emission-registration.ts`'s
  extractor against the pre-deletion file: it found `compliance.certificate_expired` but not
  `compliance.score_degraded`, because the extractor looks for genuine `event_type` writes, not
  type-array membership.

Deleted rather than fixed forward (registering a schema for a fully unwired, duplicate,
validation-bypassing module would have made the divergence "resolved" on paper while leaving
the real problem — zero production callers — untouched). If a terminal
`compliance.certificate_expired` alert is wanted, it belongs in `webhooks/compliance.ts`
(wired the same way `checkCertificateExpiry`'s 30/7/1-day warning already is, via
`dispatchWebhookEvent`) with a registered payload schema, and — separately — `webhooks/compliance.ts`
itself needs a cron/scheduler entry point, since it is (also confirmed by grep) not currently
called from any route either. That wiring gap is a distinct, larger issue, out of scope for
this fix and flagged separately for follow-up.

`scripts/ci/check-webhook-event-emission-registration.ts` (new) fails CI if a future emitter
repeats this pattern — an event type constructed for `webhook_delivery_logs` / `webhook_events`
or passed to `dispatchWebhookEvent` that has no matching key in `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`.

## 2026-07-28 SECURITY — generateAuditProof had no org scoping (fix)

**VULNERABILITY CLASS — do not reintroduce:** `generateAuditProof(signaturePublicId)` previously took only the signature's public id, with NO org scoping on the `signatures` query. Its only caller, `GET /api/v1/signatures/:id/audit-proof` in `api/v1/signatureCompliance.ts`, had **zero org check at all** — every other route in that file already used the correct `getCallerOrgId`/`isCallerOrgAdmin` pattern, but this one route was missed. Any authenticated user could pull any other org's signature audit proof (signer PII, certificate chain, eIDAS/ESIGN compliance data) by guessing/enumerating signature public ids.

**Fix:** `generateAuditProof` now takes a REQUIRED second `orgId` argument and scopes the query with `.eq('org_id', orgId)` in addition to `.eq('public_id', signaturePublicId)` — matching `bulkExportSignatures`' existing scoping pattern in this same file. A signature that exists but belongs to a different org resolves to `null` (→ 404 at the route), identical to a truly-missing signature, so no cross-org existence is ever confirmed to the caller. The route resolves `orgId` from the caller via `getCallerOrgId` (membership-only — same sensitivity class as the sibling `/signatures/export` route, not admin-gated) — never from client input.

**Pattern for any new function reading from `signatures` (or any other org-owned table) by a public/opaque id:** always take `orgId` as a required parameter and add it to the `.eq()` filter chain. Do not rely on the caller to have already checked org ownership — a query without an org filter is reachable by ANY authenticated caller regardless of what the route layer intended, and `db` is the service_role client (bypasses RLS by design, see `middleware/agents.md`).

## Do / Don't Rules

- **DO** emit compliance events through the existing webhook infrastructure (WEBHOOK-1 through WEBHOOK-4)
- **DO NOT** include raw document content in audit proof packages
- **DO NOT** add or change a query against an org-owned table without an explicit `org_id` filter derived from the authenticated caller (never from client input) — see the SECURITY note above
