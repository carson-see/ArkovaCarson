# Compliance & Audit Readiness — Product Requirements
_Created: 2026-04-05 | Status: IN PROGRESS (6/8 complete)_
_Epic: COMP (Compliance Audit Readiness)_
_Jira Epic: TBD_

---

## Overview

This epic addresses gaps identified during an internal audit readiness review of Arkova's verification infrastructure. The gaps fall into three categories:

1. **Transparency** — Making the dual evidence model (Bitcoin anchoring + AdES signatures + RFC 3161 timestamps) understandable to non-technical auditors and relying parties
2. **Independence** — Proving that verification works without Arkova's infrastructure (vendor continuity)
3. **Enterprise audit tooling** — Giving auditors the sampling, batch verification, and trend analysis tools they need to complete audits efficiently

These stories are not Phase III features — they are **cross-cutting improvements** that make existing functionality audit-defensible. They directly impact enterprise sales (SOC 2 Type II readiness), regulatory compliance (eIDAS, GDPR), and customer trust.

**Target personas:**
- SOC 2 / ISO 27001 auditors (Big 4 or boutique)
- eIDAS supervisory bodies (EU national TSA regulators)
- University CISOs evaluating Arkova for procurement
- GRC analysts using Vanta/Drata/Anecdotes
- Enterprise compliance officers

---

## WORKSTREAM 1: TRANSPARENCY

### COMP-01: Evidence Model Explainer on Verification Pages
**Priority:** P0 | **Effort:** Medium | **Depends on:** None

**As a** relying party viewing a verified credential,
**I want to** understand exactly what evidence layers are present and what each one proves,
**So that** I can assess the strength of verification without needing to contact Arkova.

The public verification page (`/verify/:publicId`) currently shows status and basic metadata. It does not explain the three independent evidence layers or what each one proves vs. does not prove.

**Files:** `src/components/public/PublicVerifyPage.tsx`, `src/lib/copy.ts`

#### What Exists
- Public verification page with status badge, fingerprint, anchor proof
- AnchorDisclaimer component (Constitution 1.5 compliance)
- Compliance badges (CML-01)

#### What's Missing
- Clear separation of evidence layers: (1) Bitcoin existence proof, (2) AdES legal signature, (3) RFC 3161 qualified timestamp
- Per-layer explanation of what is measured vs. asserted vs. NOT asserted
- Visual timeline showing when each evidence layer was acquired
- Legal effect statement per jurisdiction (eIDAS Art. 25(1) vs Art. 25(2))

#### Acceptance Criteria
- [ ] Verification page shows collapsible "Evidence Layers" section
- [ ] Each layer shows: name, timestamp, what it proves, trust anchor
- [ ] Bitcoin layer: "Proves this document existed by [block time]. Does not prove who created it."
- [ ] AdES layer (if present): "Signed by [name] using [format] [level]. Legal effect: [per jurisdiction]."
- [ ] Timestamp layer (if present): "Certified at [genTime] by [TSA name]. Qualified: [yes/no]."
- [ ] Disclaimer at bottom: "This verification confirms the integrity of the fingerprint, not the accuracy of the document's content."
- [ ] All text in `src/lib/copy.ts` (Constitution 1.3)
- [ ] `npm run lint:copy` passes
- [ ] Desktop (1280px) and mobile (375px) responsive
- [ ] No banned terminology (Constitution 1.3)

#### Implementation Tasks
- [ ] Create `EvidenceLayersSection` component in `src/components/public/`
- [ ] Add evidence layer copy strings to `src/lib/copy.ts`
- [ ] Integrate into `PublicVerifyPage.tsx` and `PublicSignatureVerifyPage.tsx`
- [ ] Add JSON-LD `VerificationResult` schema for SEO/GEO
- [ ] Write unit tests for evidence layer rendering

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- UAT verified at desktop (1280px) + mobile (375px)
- No regressions on existing verification pages

---

### COMP-02: Credential Provenance Timeline
**Priority:** P1 | **Effort:** Large | **Depends on:** None

**As an** auditor reviewing a credential,
**I want to** see the complete chain of custody from upload through verification,
**So that** I can confirm the evidence trail is unbroken and the timestamps are consistent.

**Files:** `src/components/credential/ProvenanceTimeline.tsx` (new), `services/worker/src/api/v1/verify.ts`

#### What Exists
- Anchor record with created_at, submitted_at, secured_at timestamps
- Audit events table with event_type and timestamps
- Signature records with signed_at, completed_at timestamps
- Timestamp tokens with tst_gen_time

#### What's Missing
- Single unified timeline view combining all events for a credential
- API endpoint to fetch the full provenance chain
- Visual component showing the chain with time deltas between events

#### Acceptance Criteria
- [ ] New API endpoint: `GET /api/v1/verify/:publicId/provenance`
- [ ] Returns ordered array of events: upload, fingerprint_computed, anchor_submitted, batch_included, network_confirmed, signature_created, timestamp_acquired, verification_queries
- [ ] Each event includes: event_type, timestamp, actor (anonymized), evidence_reference
- [ ] Frontend component renders vertical timeline with icons per event type
- [ ] Time deltas shown between events (e.g., "Confirmed 12 minutes after submission")
- [ ] Anomaly indicators: red flag if time deltas exceed expected bounds (e.g., >24h between submission and confirmation)
- [ ] Exportable as JSON for GRC platform ingestion
- [ ] Rate limited: 100 req/min per IP (anonymous), 1000 req/min per key

#### Implementation Tasks
- [ ] Create provenance aggregation query in worker
- [ ] Build `GET /api/v1/verify/:publicId/provenance` endpoint
- [ ] Create `ProvenanceTimeline.tsx` component
- [ ] Integrate into `PublicVerifyPage.tsx` (collapsible section)
- [ ] Write unit tests for provenance aggregation
- [ ] Write component tests for timeline rendering

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- UAT at desktop + mobile
- Documentation: `docs/confluence/11_proof_packages.md` updated

---

## WORKSTREAM 2: INDEPENDENCE & CONTINUITY

### COMP-03: Independent Verification Guide (Verify Without Arkova)
**Priority:** P0 | **Effort:** Medium | **Depends on:** None

**As a** regulator or auditor,
**I want to** verify a credential using only public data (no Arkova API),
**So that** I can confirm Arkova is not a single point of failure.

This is a critical trust differentiator. If Arkova disappears, can someone still verify? The answer is yes (Bitcoin transactions are public), but the instructions don't exist.

**Files:** `src/pages/IndependentVerifyPage.tsx` (new), route at `/verify/independent`

#### What Exists
- Bitcoin OP_RETURN data is public on mempool.space
- Merkle proof endpoint (`/api/v1/verify/:id/proof`)
- Proof package JSON with tx_id and block reference

#### What's Missing
- Step-by-step instructions for manual verification
- Command-line examples (using bitcoin-cli, curl, openssl)
- Downloadable verification script
- Public page explaining the process

#### Acceptance Criteria
- [ ] Public page at `/verify/independent` (no auth required)
- [ ] Step 1: Compute SHA-256 of document (`shasum -a 256 document.pdf`)
- [ ] Step 2: Look up the fingerprint in the Bitcoin transaction (`bitcoin-cli getrawtransaction <txid>`)
- [ ] Step 3: Decode OP_RETURN data and find the Merkle root
- [ ] Step 4: Verify the Merkle proof (provide algorithm)
- [ ] Step 5: Verify RFC 3161 timestamp token independently (`openssl ts -verify`)
- [ ] Downloadable `verify.sh` script that automates steps 1-4
- [ ] FAQ section: "What if Arkova shuts down?" "What if the website is offline?"
- [ ] All text in `src/lib/copy.ts`
- [ ] HowTo JSON-LD schema for SEO

#### Implementation Tasks
- [ ] Create `IndependentVerifyPage.tsx`
- [ ] Add route to `routes.ts` and `App.tsx`
- [ ] Write `public/verify.sh` verification script
- [ ] Add copy strings
- [ ] Write component test

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- UAT at desktop + mobile
- `verify.sh` tested against a real SECURED anchor

---

### COMP-04: Data Retention Policy Page
**Priority:** P1 | **Effort:** Small | **Depends on:** None

**As a** GDPR regulator or data subject,
**I want to** find Arkova's data retention policies in a public, linkable location,
**So that** I can verify compliance with GDPR Art. 13/14 transparency requirements.

**Files:** `src/pages/DataRetentionPage.tsx` (new), route at `/privacy/data-retention`

#### What Exists
- Privacy page at `/privacy`
- GDPR Article 30 export in compliance center
- Data classification doc at `docs/confluence/17_data_classification.md`
- Retention policy in `docs/confluence/05_retention_legal_hold.md`

#### What's Missing
- Public-facing data retention page (current info is internal docs only)
- Per-data-category retention periods
- Right to erasure instructions
- Legal hold policy explanation

#### Acceptance Criteria
- [ ] Public page at `/privacy/data-retention`
- [ ] Table showing: data category, retention period, legal basis, deletion method
- [ ] Categories: anchor records (10 years, eIDAS Art. 24(2)), audit events (7 years, SOC 2), user accounts (until deletion requested), signature records (10 years), timestamp tokens (10 years)
- [ ] Right to erasure section: how to request deletion, what can/cannot be deleted (Bitcoin anchors are permanent)
- [ ] Legal hold section: when retention can be extended
- [ ] Linked from Privacy page and compliance center
- [ ] All text in `src/lib/copy.ts`

#### Implementation Tasks
- [ ] Create `DataRetentionPage.tsx`
- [ ] Add route and nav link from Privacy page
- [ ] Add copy strings
- [ ] Write component test

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- UAT at desktop + mobile

---

### COMP-05: Key Ceremony Documentation & Audit Evidence
**Priority:** P1 | **Effort:** Medium | **Depends on:** None

**As a** SOC 2 auditor examining CC6.1 (logical access controls),
**I want to** see documented evidence of how cryptographic keys were generated, who authorized them, and what controls protect them,
**So that** I can verify key management meets trust service criteria.

**Files:** `docs/confluence/14_kms_operations.md` (update), `services/worker/src/api/v1/signatureCompliance.ts` (new endpoint)

#### What Exists
- KMS operations doc at `docs/confluence/14_kms_operations.md`
- AWS KMS and GCP KMS providers in code
- Bitcoin signing keys managed via KMS

#### What's Missing
- Formal key ceremony record (who generated, when, witnesses, procedure followed)
- API endpoint to export key inventory for audit
- Key rotation history log
- Separation of duties evidence (who can create keys vs. who can use them)

#### Acceptance Criteria
- [ ] `docs/confluence/14_kms_operations.md` updated with key ceremony template
- [ ] Template includes: date, participants, procedure, key ID (redacted), algorithm, purpose, approval chain
- [ ] New API endpoint: `GET /api/v1/signatures/key-inventory` (admin/compliance_officer only)
- [ ] Key inventory returns: key ID (masked), algorithm, creation date, last rotation date, purpose, status
- [ ] Never returns raw key material, ARNs, or resource paths (Constitution 1.4)
- [ ] Key rotation events logged to `audit_events`

#### Implementation Tasks
- [ ] Update `docs/confluence/14_kms_operations.md` with ceremony template
- [ ] Add key inventory endpoint to `signatureCompliance.ts`
- [ ] Write unit test for key inventory (mock KMS)

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- Documentation: `docs/confluence/14_kms_operations.md` updated

---

## WORKSTREAM 3: ENTERPRISE AUDIT TOOLING

### COMP-06: Batch Verification & Audit Sampling
**Priority:** P0 | **Effort:** Large | **Depends on:** None

**As an** auditor conducting a SOC 2 or ISO 27001 audit,
**I want to** upload a list of credential IDs and get a batch verification report,
**So that** I can complete my audit sampling in hours instead of days.

Auditors use ISA 530 (audit sampling) to select a statistical sample and verify each item. Currently they'd need to check credentials one at a time.

**Files:** `services/worker/src/api/v1/audit-batch-verify.ts` (new), `src/pages/AuditorBatchPage.tsx` (new)

#### What Exists
- Batch verification endpoint (`POST /api/v1/verify/batch`) — API key only
- Auditor mode toggle (VAI-04)
- Individual verification works

#### What's Missing
- Auditor-specific batch tool with sampling options
- Random sampling mode: "verify N% of all credentials"
- Upload CSV of credential IDs for batch check
- Downloadable audit report with pass/fail per credential
- Anomaly detection: flag credentials with unusual patterns

#### Acceptance Criteria
- [ ] New API endpoint: `POST /api/v1/audit/batch-verify`
- [ ] Accepts: `{ credential_ids: string[] }` OR `{ sample_percentage: number, seed: number }`
- [ ] Random sampling uses deterministic seed for reproducibility (auditors need to reproduce results)
- [ ] Response: per-credential result (pass/fail, status, anchor proof, timestamp, any anomalies)
- [ ] Anomalies flagged: missing timestamps, >24h anchor delay, revoked-then-re-anchored, orphan signatures
- [ ] Downloadable CSV report with all results
- [ ] Frontend auditor batch page (accessible in auditor mode only)
- [ ] Upload CSV of credential IDs
- [ ] Max batch size: 1000 per request
- [ ] Rate limited: 5 req/min (batch operations are expensive)

#### Implementation Tasks
- [ ] Create `audit-batch-verify.ts` endpoint
- [ ] Implement random sampling with seed-based PRNG
- [ ] Implement anomaly detection rules
- [ ] Create `AuditorBatchPage.tsx` component
- [ ] Wire into auditor mode sidebar
- [ ] Write unit tests: batch verification, sampling reproducibility, anomaly detection
- [ ] Write integration test: CSV upload → report download

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- UAT at desktop + mobile (auditor mode)
- Documentation: `docs/confluence/12_identity_access.md` updated

---

### COMP-07: Compliance Trend Dashboard
**Priority:** P1 | **Effort:** Medium | **Depends on:** COMP-06

**As a** CISO or compliance officer,
**I want to** see compliance metrics trending over time,
**So that** I can demonstrate continuous improvement to auditors and identify degradation early.

**Files:** `src/pages/ComplianceTrendPage.tsx` (new), `services/worker/src/api/v1/signatureCompliance.ts` (new endpoint)

#### What Exists
- Point-in-time compliance reports (SOC 2, eIDAS)
- Compliance dashboard page (`SignatureCompliancePage.tsx`)
- Audit events table with timestamps

#### What's Missing
- Time-series compliance data
- KPI definitions (what "good" looks like)
- Trend visualization (weekly/monthly)
- Alert thresholds for degradation

#### Acceptance Criteria
- [ ] New API endpoint: `GET /api/v1/signatures/compliance-trends`
- [ ] Params: `granularity` (daily/weekly/monthly), `from`, `to`
- [ ] Returns time-series data for: total signatures, qualified timestamp coverage %, LTV coverage %, average anchor delay, certificate health (active vs expired)
- [ ] Frontend page with line charts for each KPI
- [ ] Green/amber/red thresholds: e.g., timestamp coverage >95% = green, 80-95% = amber, <80% = red
- [ ] Exportable as CSV for board reporting
- [ ] Accessible from compliance center sidebar

#### Implementation Tasks
- [ ] Create compliance trends aggregation query
- [ ] Add `GET /api/v1/signatures/compliance-trends` endpoint
- [ ] Create `ComplianceTrendPage.tsx` with charts (use recharts or similar)
- [ ] Add threshold configuration
- [ ] Write unit tests for aggregation logic

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- UAT at desktop + mobile

---

### COMP-08: Compliance Event Webhooks
**Priority:** P2 | **Effort:** Medium | **Depends on:** COMP-07

**As a** GRC platform integration (Vanta, Drata),
**I want to** receive real-time webhook notifications for compliance-relevant events,
**So that** my continuous monitoring dashboard stays current without polling.

**Files:** `services/worker/src/api/v1/webhooks/compliance.ts` (new)

#### What Exists
- Webhook infrastructure (WEBHOOK-1 through WEBHOOK-4)
- Webhook endpoints, delivery tracking, retry with exponential backoff
- Event types: credential.anchored, credential.verification.completed, anchor.batch.confirmed

#### What's Missing
- Compliance-specific event types
- Certificate expiry warnings (7-day, 1-day)
- Anchor delay alerts (>1h, >24h)
- Signature revocation notifications
- Compliance score change alerts

#### Acceptance Criteria
- [ ] New webhook event types: `compliance.certificate_expiring`, `compliance.anchor_delayed`, `compliance.signature_revoked`, `compliance.score_degraded`, `compliance.timestamp_coverage_low`
- [ ] Certificate expiry: fires at 30-day, 7-day, 1-day before expiry
- [ ] Anchor delay: fires when batch hasn't processed in >1h
- [ ] Score degraded: fires when any KPI drops below amber threshold
- [ ] Events configurable per webhook endpoint (opt-in)
- [ ] Existing webhook retry and delivery tracking infrastructure reused

#### Implementation Tasks
- [ ] Define new event types in webhook event registry
- [ ] Create compliance event emitters (cron job for certificate expiry, hook into anchor batch for delays)
- [ ] Add compliance events to webhook configuration UI
- [ ] Write unit tests for each event trigger condition
- [ ] Update `docs/confluence/09_webhooks.md` and `docs/confluence/14_webhook_events.md`

#### Definition of Done
- All acceptance criteria met
- `typecheck` + `lint` + `test` + `lint:copy` green
- Documentation: webhook Confluence pages updated

---

## DEPENDENCY GRAPH

```
COMP-01 (Evidence Explainer)     ── no deps
COMP-02 (Provenance Timeline)    ── no deps
COMP-03 (Independent Verify)     ── no deps
COMP-04 (Data Retention Page)    ── no deps
COMP-05 (Key Ceremony Docs)      ── no deps
COMP-06 (Batch Verify + Sampling) ── no deps
COMP-07 (Compliance Trends)      ── COMP-06
COMP-08 (Compliance Webhooks)    ── COMP-07
```

Sprint order: COMP-01, COMP-03, COMP-06 (P0s first), then COMP-02, COMP-04, COMP-05, COMP-07, COMP-08.

---

## EFFORT SUMMARY

| ID | Story | Priority | Effort | Sprint |
|----|-------|----------|--------|--------|
| COMP-01 | Evidence Model Explainer | P0 | Medium | S1 |
| COMP-02 | Provenance Timeline | P1 | Large | S2 |
| COMP-03 | Independent Verification Guide | P0 | Medium | S1 |
| COMP-04 | Data Retention Policy Page | P1 | Small | S1 |
| COMP-05 | Key Ceremony Documentation | P1 | Medium | S2 |
| COMP-06 | Batch Verification & Sampling | P0 | Large | S1 |
| COMP-07 | Compliance Trend Dashboard | P1 | Medium | S2 |
| COMP-08 | Compliance Event Webhooks | P2 | Medium | S3 |

**Total effort:** ~4-6 weeks across 2-3 sprints.

---

_Story doc version: 2026-04-05 | Author: Architecture Review_
_Related: docs/stories/23_phase3_esignatures.md (Phase III), docs/confluence/16_incident_response.md (IR plan)_
