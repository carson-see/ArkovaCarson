# ATS & Background Check Integration Stories
_Created: 2026-03-28 | Priority: P9 | Status: NOT STARTED_
_Research: 3 parallel agents — background check industry, attestation standards, existing codebase audit_

---

## Executive Summary

Arkova's existing attestation infrastructure (9 types, Bitcoin-anchored, public verification, revocation) is feature-complete for core functionality. This story group extends it into the **$14.7B background screening market** by building workflows that let staffing agencies, background screening firms, and HR teams verify credentials at scale through our API.

**ICP alignment:** Recruiting/staffing agencies are buyer #1 (shortest buying cycle, API consumers, high-volume). This group builds the product they need.

**What exists today:**
- 9 attestation types (VERIFICATION, ENDORSEMENT, AUDIT, APPROVAL, COMPLIANCE, SUPPLY_CHAIN, IDENTITY, WITNESS, CUSTOM)
- Full lifecycle: DRAFT > PENDING > ACTIVE > REVOKED/EXPIRED
- Bitcoin Merkle-batched anchoring (batch 100/tx)
- Public verification at `/verify/attestation/:publicId`
- API: create, retrieve, list, revoke attestations
- Structured public IDs: `ARK-{org}-{type}-{unique}`
- Evidence table exists but no upload UI

**What's missing (this story group builds):**
- Employment verification attestation workflow
- Education verification attestation workflow
- Batch attestation verification API endpoint
- ATS webhook integration (inbound triggers)
- Candidate credential portfolio (shareable bundle)
- Evidence upload UI
- Attestation OpenAPI spec documentation
- Expiry monitoring and re-verification alerts

---

## Market Context

### The Problem We Solve

| Pain Point | Current State | Arkova Solution |
|-----------|--------------|-----------------|
| Verification takes days | Employment verification: 2-5 days, education: 1-3 days, "registrar phone tag" | Pre-anchored credentials verify in milliseconds via API |
| Credential fraud is rampant | 70% of workers lie on resumes, Gartner: 25% fake candidates by 2028 | Tamper-proof cryptographic proof, Bitcoin-anchored timestamps |
| No universal standard | Each screening provider has its own API schema | Single API call returns issuer, status, timestamp, chain proof |
| Compliance complexity | 37+ ban-the-box jurisdictions, FCRA, clean slate laws | Audit-ready evidence with timestamp, querying entity, result |
| Redundant verification | Same credential re-verified for every new employer | Anchor once, verify forever. Portable proof |
| Monopoly pricing | Equifax/Work Number dominates with 670M records | Open verification, no per-lookup fees for anchored credentials |

### Market Size
- Background screening: $14.72B (2025), $25.92B by 2030 (CAGR 12%)
- Decentralized identity: $2.56-4.89B (2025), $7.4B by 2026 (CAGR 50%+)
- W3C Verifiable Credentials 2.0 became a full standard May 2025
- EU mandating digital identity wallets by end of 2026

### Competitive Landscape
- **Checkr** — API-first, gig economy focus, acquired Truework
- **Sterling/First Advantage** — merged ($2.2B), enterprise, REST API + sandbox
- **Equifax Work Number** — 670M records, monopoly pricing, antitrust pressure
- **Emerging:** Truv, Argyle, Plaid Income, Hyland Credentials, Dock/Truvera

**Arkova's wedge:** We don't replace background check firms. We give credential issuers (universities, employers, certification bodies) a way to make their credentials instantly verifiable, so screening firms can call one API instead of playing phone tag.

---

## Stories

### ATT-01: Employment Verification Attestation Workflow
**Priority:** HIGH | **Effort:** Large | **Dependencies:** Existing attestation infrastructure

**As an** organization admin (employer HR),
**I want to** create employment verification attestations for current and former employees,
**So that** background screening firms and future employers can verify employment instantly via API.

**Acceptance Criteria:**
- [ ] New "Employment Verification" template in attestation creation flow
- [ ] Pre-populated fields: employee name, title, department, employment dates, employment status (current/former), salary band (optional, requires employee consent flag)
- [ ] Employee consent tracking (consent_given_at timestamp, consent_scope: dates_only | dates_and_title | full)
- [ ] Attestation type: VERIFICATION, subject_type: entity
- [ ] Claims auto-structured: `{claim: "Employment dates", evidence: "2022-01-15 to present"}`, `{claim: "Job title", evidence: "Senior Software Engineer"}`, etc.
- [ ] Bulk creation via CSV upload (reuse existing CsvUploader)
- [ ] Auto-anchored via existing attestation batch job
- [ ] Shareable verification URL: `/verify/attestation/ARK-{org}-VER-{id}`
- [ ] Public verification page shows: employer name, employment dates, title, status, anchor timestamp, chain proof

**Technical Notes:**
- Leverage existing `attestations` table, no schema changes needed
- Add employment-specific metadata to `claims` JSONB
- New component: `src/components/attestation/EmploymentVerificationForm.tsx`
- Consent stored in `metadata` JSONB field: `{consent: {scope, given_at, given_by}}`

---

### ATT-02: Education Verification Attestation Workflow
**Priority:** HIGH | **Effort:** Large | **Dependencies:** Existing attestation infrastructure

**As a** university registrar or academic institution,
**I want to** issue tamper-proof attestations for degrees, transcripts, and certifications,
**So that** employers and screening firms can verify credentials instantly without calling our office.

**Acceptance Criteria:**
- [ ] New "Education Credential" template in attestation creation flow
- [ ] Pre-populated fields: student name, degree type, field of study, institution, graduation date, GPA (optional), honors (optional)
- [ ] Attestation type: VERIFICATION, subject_type: credential
- [ ] Claims auto-structured: `{claim: "Degree", evidence: "Bachelor of Science"}`, `{claim: "Field of study", evidence: "Computer Science"}`, etc.
- [ ] Bulk issuance: CSV with columns (student_name, degree, field, graduation_date)
- [ ] QR code on verification page for physical diploma supplement
- [ ] Links to existing anchor if credential document was previously anchored (`anchor_id` FK)
- [ ] Public verification shows: institution name, degree, field, graduation date, anchor proof

**Technical Notes:**
- Reuse attestation infrastructure with education-specific claim templates
- New component: `src/components/attestation/EducationVerificationForm.tsx`
- Consider linking to National Student Clearinghouse data format for interop

---

### ATT-03: Batch Attestation Verification API Endpoint
**Priority:** HIGH | **Effort:** Medium | **Dependencies:** ATT-01 or ATT-02

**As a** background screening firm or staffing agency,
**I want to** verify up to 100 attestations in a single API call,
**So that** I can process candidate credential checks at scale without making individual requests.

**Acceptance Criteria:**
- [ ] `POST /api/v1/attestations/batch-verify` endpoint
- [ ] Request body: `{ public_ids: ["ARK-UMI-VER-A3F2B1", ...] }` (max 100)
- [ ] Response: array of verification results, each with status, subject, attester, chain proof, expiry
- [ ] Partial success supported (some valid, some not found)
- [ ] API key required (existing API key infrastructure)
- [ ] Rate limited: 10 req/min (batch tier)
- [ ] Response includes `verified_count`, `not_found_count`, `expired_count`
- [ ] OpenAPI spec updated

**Technical Notes:**
- New route in `services/worker/src/api/v1/attestations.ts`
- Reuse existing single-attestation lookup logic in a loop with DB batch query
- `SELECT * FROM attestations WHERE public_id = ANY($1::text[])`

---

### ATT-04: ATS Webhook Integration (Inbound)
**Priority:** MEDIUM | **Effort:** Large | **Dependencies:** ATT-03

**As a** staffing agency using Greenhouse, Lever, or another ATS,
**I want** Arkova to receive a webhook when a candidate reaches the "background check" stage,
**So that** credential verification happens automatically without manual API calls.

**Acceptance Criteria:**
- [ ] `POST /api/v1/webhooks/ats` endpoint accepts ATS webhook payloads
- [ ] Supported formats: Greenhouse (candidate stage change), Lever (stage change), generic (configurable)
- [ ] Webhook maps candidate identifiers to existing attestation public IDs
- [ ] Auto-triggers batch verification for all credentials linked to candidate
- [ ] Returns verification results via callback URL or stores for polling
- [ ] Webhook signature verification (HMAC) for each supported ATS
- [ ] Configuration UI: org admin maps ATS fields to Arkova lookup fields
- [ ] Webhook event logged in audit trail

**Technical Notes:**
- New route: `services/worker/src/api/v1/webhooks/ats.ts`
- Webhook config stored in `organizations` metadata or new `ats_integrations` table
- Consider: Greenhouse uses `X-Greenhouse-Signature` header, Lever uses `X-Lever-Signature`
- Phase 1: Greenhouse + generic. Phase 2: Lever, Workday, iCIMS

---

### ATT-05: Candidate Credential Portfolio
**Priority:** MEDIUM | **Effort:** Medium | **Dependencies:** ATT-01, ATT-02

**As a** job candidate,
**I want to** share a single link that bundles all my verified credentials,
**So that** employers and recruiters can verify everything at once instead of checking each credential separately.

**Acceptance Criteria:**
- [ ] New "Credential Portfolio" concept: a shareable bundle of attestations + anchored documents
- [ ] Portfolio has its own public URL: `/portfolio/{portfolioId}`
- [ ] Candidate selects which credentials to include (consent-based sharing)
- [ ] Portfolio page shows: list of credentials, each with verification status, issuer, anchor proof
- [ ] "Verify All" button triggers batch verification
- [ ] Portfolio can be shared via link or QR code
- [ ] Portfolio is read-only (no PII beyond what's in the attestation claims)
- [ ] Optional expiry on portfolio link (7 days, 30 days, permanent)

**Technical Notes:**
- New table: `credential_portfolios` (id, public_id, user_id, title, attestation_ids[], anchor_ids[], expires_at, created_at)
- New page: `src/pages/PublicPortfolioPage.tsx`
- RLS: owner can CRUD, public can SELECT active portfolios

---

### ATT-06: Evidence Upload UI
**Priority:** MEDIUM | **Effort:** Small | **Dependencies:** None (table exists)

**As an** attestation creator,
**I want to** attach supporting evidence files (letters, reports, assessments) to my attestations,
**So that** verifiers can see the documentation behind the attestation.

**Acceptance Criteria:**
- [ ] File upload component on attestation creation and detail pages
- [ ] Files fingerprinted client-side (SHA-256, same as document anchoring)
- [ ] Only fingerprint + metadata stored server-side (privacy-first)
- [ ] Evidence listed on public verification page with fingerprint for independent verification
- [ ] Supported evidence types: document, letter, report, assessment
- [ ] Max 10 evidence files per attestation
- [ ] Evidence deletion by attestation owner only

**Technical Notes:**
- `attestation_evidence` table already exists with RLS
- New component: `src/components/attestation/EvidenceUpload.tsx`
- Reuse `FileUpload.tsx` patterns for client-side fingerprinting

---

### ATT-07: Attestation OpenAPI Documentation
**Priority:** HIGH | **Effort:** Small | **Dependencies:** None

**As a** developer integrating with the Arkova API,
**I want** complete OpenAPI documentation for all attestation endpoints,
**So that** I can integrate quickly without guessing at request/response schemas.

**Acceptance Criteria:**
- [ ] All 4 existing endpoints documented: POST create, GET retrieve, GET list, PATCH revoke
- [ ] New batch-verify endpoint documented (ATT-03)
- [ ] Request/response schemas with examples
- [ ] Error codes and error response format
- [ ] Authentication requirements (JWT Bearer for create/revoke, API key for batch, none for public verify)
- [ ] Rate limit documentation
- [ ] Added to existing `docs/api/openapi.yaml`
- [ ] Docs page at arkova.ai updated

**Technical Notes:**
- Follow existing OpenAPI patterns in `docs/api/openapi.yaml`
- Update marketing site docs page after spec complete

---

### ATT-08: Expiry Monitoring and Re-verification Alerts
**Priority:** LOW | **Effort:** Medium | **Dependencies:** ATT-01, ATT-02

**As an** organization that relies on verified credentials,
**I want to** receive alerts when attestations I've verified are expiring or have been revoked,
**So that** I can take action before a credential lapses.

**Acceptance Criteria:**
- [ ] Webhook event: `attestation.expiring` (30 days before, 7 days before, on expiry)
- [ ] Webhook event: `attestation.revoked` (immediate)
- [ ] Configurable alert thresholds per organization
- [ ] Dashboard widget showing upcoming expirations
- [ ] Email notification option (via existing Resend infrastructure)
- [ ] Cron job checks attestation expiry daily

**Technical Notes:**
- New cron route: `/cron/check-attestation-expiry`
- Leverages existing webhook infrastructure (`docs/confluence/09_webhooks.md`)
- Query: `SELECT * FROM attestations WHERE status = 'ACTIVE' AND expires_at BETWEEN now() AND now() + interval '30 days'`

---

## UI Wireframes (Text-Based)

### Employment Verification Form (ATT-01)

```
+-----------------------------------------------+
| Create Employment Verification                 |
+-----------------------------------------------+
| Employee Information                           |
| Name:        [____________________________]    |
| Title:       [____________________________]    |
| Department:  [____________________________]    |
|                                                |
| Employment Details                             |
| Start Date:  [__________]                      |
| End Date:    [__________] ☐ Currently employed |
| Status:      [Current ▼]                       |
|                                                |
| Compensation (requires employee consent)       |
| ☐ Include salary band                         |
| Salary Band: [____________________________]    |
|                                                |
| Consent                                        |
| Scope: [Dates and title only ▼]               |
| ☐ Employee has provided written consent        |
|                                                |
| [Cancel]                    [Create & Anchor]  |
+-----------------------------------------------+
```

### Candidate Portfolio Page (ATT-05)

```
+-----------------------------------------------+
| Verified Credential Portfolio                  |
| for Jane Smith                                 |
+-----------------------------------------------+
| ✓ VERIFIED  Bachelor of Science, CS            |
|   Issued by: University of Michigan            |
|   Graduated: 2020-05-15                        |
|   Anchored: 2026-01-10 (Block #876543)        |
|   [View Full Verification →]                   |
+-----------------------------------------------+
| ✓ VERIFIED  Employment: Acme Corp              |
|   Role: Senior Software Engineer               |
|   Dates: 2020-06 to 2024-12                   |
|   Anchored: 2026-02-01 (Block #878901)        |
|   [View Full Verification →]                   |
+-----------------------------------------------+
| ✓ VERIFIED  AWS Solutions Architect            |
|   Issued by: Amazon Web Services               |
|   Expires: 2027-03-15                          |
|   Anchored: 2026-03-01 (Block #880123)        |
|   [View Full Verification →]                   |
+-----------------------------------------------+
| [Verify All Credentials]     [Download PDF]    |
+-----------------------------------------------+
| Portfolio ID: PF-JS-2026-A3F2                  |
| Generated: 2026-03-28                          |
| Expires: 2026-04-28 (30 days)                  |
+-----------------------------------------------+
```

---

## Database Changes

### New Tables

**`credential_portfolios`** (ATT-05)
```sql
CREATE TABLE credential_portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  attestation_ids uuid[] DEFAULT '{}',
  anchor_ids uuid[] DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE credential_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_portfolios FORCE ROW LEVEL SECURITY;
```

**`ats_integrations`** (ATT-04)
```sql
CREATE TABLE ats_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL, -- 'greenhouse', 'lever', 'generic'
  webhook_secret text NOT NULL,
  callback_url text,
  field_mapping jsonb DEFAULT '{}',
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE ats_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_integrations FORCE ROW LEVEL SECURITY;
```

### No Changes Needed
- `attestations` table: sufficient for employment and education attestations via JSONB claims
- `attestation_evidence` table: already exists
- `attestation_status` enum: sufficient (DRAFT, PENDING, ACTIVE, REVOKED, EXPIRED, CHALLENGED)

---

## API Design

### Batch Verify (ATT-03)

```
POST /api/v1/attestations/batch-verify
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "public_ids": [
    "ARK-UMI-VER-A3F2B1",
    "ARK-ACM-VER-C7D8E9",
    "ARK-AWS-VER-F0G1H2"
  ]
}

Response 200:
{
  "results": [
    {
      "public_id": "ARK-UMI-VER-A3F2B1",
      "found": true,
      "status": "ACTIVE",
      "attestation_type": "VERIFICATION",
      "subject_identifier": "Bachelor of Science, Computer Science",
      "attester": { "name": "University of Michigan", "type": "INSTITUTION" },
      "issued_at": "2026-01-10T14:30:00Z",
      "expires_at": null,
      "chain_proof": {
        "tx_id": "abc123...",
        "block_height": 876543,
        "timestamp": "2026-01-10T15:00:00Z",
        "explorer_url": "https://mempool.space/tx/abc123..."
      }
    },
    {
      "public_id": "ARK-ACM-VER-C7D8E9",
      "found": true,
      "status": "ACTIVE",
      ...
    },
    {
      "public_id": "ARK-AWS-VER-INVALID",
      "found": false,
      "status": null,
      "error": "Attestation not found"
    }
  ],
  "summary": {
    "total": 3,
    "verified": 2,
    "not_found": 1,
    "expired": 0,
    "revoked": 0
  }
}
```

### ATS Webhook (ATT-04)

```
POST /api/v1/webhooks/ats
X-Greenhouse-Signature: sha256=...
Content-Type: application/json

{
  "action": "candidate_stage_change",
  "payload": {
    "candidate": {
      "id": 12345,
      "first_name": "Jane",
      "last_name": "Smith",
      "email_addresses": [{ "value": "jane@example.com" }]
    },
    "stage": {
      "name": "Background Check"
    }
  }
}

Response 202:
{
  "status": "accepted",
  "verification_id": "vrf_abc123",
  "poll_url": "/api/v1/verifications/vrf_abc123"
}
```

---

## Implementation Order

| Phase | Stories | Rationale |
|-------|---------|-----------|
| **Phase 1: Foundation** | ATT-07, ATT-06 | Document what exists, add evidence UI. No new infrastructure. |
| **Phase 2: Workflows** | ATT-01, ATT-02 | Employment and education templates. Uses existing attestation system. |
| **Phase 3: Scale** | ATT-03, ATT-05 | Batch API and portfolios. The staffing agency product. |
| **Phase 4: Integration** | ATT-04, ATT-08 | ATS webhooks and monitoring. Requires org config UI. |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|-----------|
| FCRA compliance for employment verification | HIGH: incorrect implementation could create legal liability | Arkova anchors issuer attestations, not consumer reports. We are not a CRA. Clear disclaimers. Legal review before launch. |
| Consent management for salary data | MEDIUM: privacy violation if salary shared without consent | Consent flag required, scope tracked, audit trail |
| ATS webhook reliability | MEDIUM: missed webhooks cause missed verifications | Idempotent processing, retry logic, webhook event log |
| Adoption requires issuers to participate | HIGH: chicken-and-egg problem | Start with universities already anchoring credentials, expand to employers. Offer free tier for issuers. |
| W3C VC interop expectations | LOW: market expects VC format | Future story: VC wrapper around Arkova attestations. Not blocking for staffing buyer. |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Employment attestations created | 1,000 in first 90 days | DB count |
| Batch verify API calls | 100/day within 60 days of launch | API analytics |
| Average verification time | < 200ms (single), < 2s (batch 100) | API latency monitoring |
| ATS integrations configured | 5 orgs in first 90 days | DB count |
| Credential portfolios created | 500 in first 90 days | DB count |

---

_Story group: 18_ats_background_checks | 8 stories | Created 2026-03-28_
_Research sources: Mordor Intelligence, First Advantage, Checkr, W3C, Equifax, Dock.io, EY, Gartner, FCRA guidelines_
