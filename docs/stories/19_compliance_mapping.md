# Story Group 19: Compliance Mapping Layer (CML)
_Created: 2026-03-29 | Source: [Strategic Blueprint — The Immutable Compliance Fabric](https://docs.google.com/document/d/1yLGX5zJ6xWu_J2J-510n0yQZZe9YfzLTK_h7wm3mqyQ/edit)_

## Overview

Implement "Compliance Context" across the UI/UX, mapping every verification to regulatory controls (SOC 2, GDPR, FERPA, ISO 27001, eIDAS) to transform Arkova from a verification utility into enterprise compliance infrastructure.

**Strategic Positioning:** The "Automated Registrar" — Outcome-as-a-Service for understaffed registrars and IT teams. Compliance Mapping turns an "IT purchase" into a "Risk Management necessity."

**Target:** CRO / GRC teams
**Jira Epic:** SCRUM-263

## Three Levels

1. **Level 1 (UI):** Compliance badges on every verification (CML-01)
2. **Level 2 (Metadata):** Regulatory control IDs in Bitcoin inscription metadata (CML-02)
3. **Level 3 (Audit Export):** One-click "Audit-Ready" PDF for GRC platforms (CML-03)

## Stories

### CML-01: Compliance Badges on Verifications (Level 1 UI)
**Jira:** SCRUM-265 | **Priority:** HIGH | **Effort:** M | **Status:** COMPLETE
**Dependencies:** None (builds on existing attestation UI)

Add "Compliance Badge" to every verification/attestation, mapping each action to specific regulatory controls.

**Key controls:** SOC 2 CC6.7, SOC 2 CC6.1, GDPR Art. 5(1)(f), FERPA §99.31, ISO 27001 A.10, eIDAS Art. 25

**Deliverables:**
- ~~New `compliance_controls` reference table (migration)~~ — Static mapping (no DB table needed for Level 1)
- `src/components/anchor/ComplianceBadge.tsx` — Compact/full modes, color-coded per framework
- `src/lib/complianceMapping.ts` — 10 controls, 7 universal + type-specific
- `src/lib/complianceMapping.test.ts` — 16 tests
- Integrated into AssetDetailView (SECURED anchors) and PublicVerification page

### CML-02: Regulatory Control IDs in Anchor Metadata (Level 2)
**Jira:** SCRUM-266 | **Priority:** HIGH | **Effort:** L | **Status:** COMPLETE
**Dependencies:** CML-01

Anchor regulatory control IDs into Bitcoin inscription metadata alongside document fingerprint.

**Deliverables:**
- `supabase/migrations/0137_compliance_controls_column.sql` — JSONB column + GIN index
- `services/worker/src/utils/complianceMapping.ts` — Worker-side mapping (mirrors frontend)
- `services/worker/src/utils/complianceMapping.test.ts` — 10 tests
- `services/worker/src/jobs/anchor.ts` — Populates compliance_controls on individual SUBMITTED anchors
- `services/worker/src/jobs/batch-anchor.ts` — Populates compliance_controls on batch anchors (grouped by credential_type)
- Additive nullable JSONB (Constitution 1.8 frozen schema compliant)

### CML-03: Audit-Ready PDF Export for GRC Platforms (Level 3)
**Jira:** SCRUM-267 | **Priority:** HIGH | **Effort:** L | **Status:** COMPLETE
**Dependencies:** CML-01, CML-02

One-click "Audit-Ready" PDF for GRC platforms (Anecdotes, Vanta, Drata). "Reduces audit prep time by 80%."

**Deliverables:**
- `services/worker/src/api/v1/audit-export.ts` — Two endpoints:
  - `POST /api/v1/audit-export` — Single anchor PDF or CSV (auth + org-scoped)
  - `POST /api/v1/audit-export/batch` — Batch org export (PDF summary or CSV, max 500)
- PDF includes: document info, SHA-256 fingerprint, chain proof (TX, block, merkle root), compliance controls grouped by framework, lifecycle timeline, disclaimers
- CSV includes: verification_id, fingerprint, credential_type, status, network_receipt, compliance_controls, compliance_frameworks, all lifecycle dates
- `services/worker/src/api/v1/audit-export.test.ts` — 12 tests
- Mounted in router behind `requireAuth` middleware

### CML-04: Compliance Dashboard & Reporting
**Jira:** SCRUM-268 | **Priority:** MEDIUM | **Effort:** M | **Status:** COMPLETE
**Dependencies:** CML-01

Compliance dashboard showing org-wide posture, control coverage heatmap, and "Audit Readiness Score."

**Deliverables:**
- Enhanced `src/pages/ComplianceDashboardPage.tsx`:
  - Regulatory Framework Coverage section — visual pills for SOC 2, GDPR, ISO 27001, eIDAS, FERPA, HIPAA
  - Coverage stats: secured records, controls evidenced, frameworks covered (N/6)
  - Gap analysis: lists controls not yet evidenced with AlertTriangle indicators
  - Export panel: PDF + CSV batch download buttons triggering `/api/v1/audit-export/batch`
- New labels in `src/lib/copy.ts` (12 new COMPLIANCE_LABELS entries)
- Queries anchors with `compliance_controls` column for coverage computation

### CML-05: GRC Platform Integrations (Vanta, Drata, Anecdotes)
**Jira:** SCRUM-269 | **Priority:** MEDIUM | **Effort:** XL | **Status:** COMPLETE
**Dependencies:** CML-03

Direct API integrations with GRC platforms for automated evidence delivery.

**Deliverables:**
- `supabase/migrations/0139_grc_connections.sql` — `grc_connections` + `grc_sync_logs` tables, RLS, indexes, enums
- `services/worker/src/integrations/grc/types.ts` — IGrcAdapter interface, evidence payload types
- `services/worker/src/integrations/grc/adapters.ts` — VantaAdapter, DrataAdapter, AnecdotesAdapter (OAuth2 + evidence push)
- `services/worker/src/integrations/grc/syncService.ts` — Sync orchestration on SECURED status
- `services/worker/src/api/v1/grc.ts` — 6 endpoints (connect, callback, list, test, disconnect, sync-logs)
- `services/worker/src/middleware/grcFeatureGate.ts` — ENABLE_GRC_INTEGRATIONS switchboard flag gate
- `services/worker/src/integrations/grc/grc.test.ts` — 27 tests
- Switchboard flag: `ENABLE_GRC_INTEGRATIONS` (default: false)

## Status Summary

| Story | Status | Priority |
|-------|--------|----------|
| CML-01 | COMPLETE | HIGH |
| CML-02 | COMPLETE | HIGH |
| CML-03 | COMPLETE | HIGH |
| CML-04 | COMPLETE | MEDIUM |
| CML-05 | COMPLETE | MEDIUM |

## Change Log

| Date | Change |
|------|--------|
| 2026-03-29 | Initial creation from Strategic Blueprint document |
| 2026-03-29 | CML-01 COMPLETE: ComplianceBadge component, complianceMapping engine (16 tests) |
| 2026-03-29 | CML-02 COMPLETE: Migration 0137, worker-side mapping, anchor.ts + batch-anchor.ts integration (10 tests) |
| 2026-03-29 | CML-03 COMPLETE: Audit export endpoint (PDF + CSV), single + batch, 12 tests |
| 2026-03-29 | CML-04 COMPLETE: Dashboard enhanced with framework coverage, gap analysis, export panel |
| 2026-03-29 | CML-05 COMPLETE: Migration 0139, 3 GRC adapters (Vanta/Drata/Anecdotes), 6 API endpoints, sync service, feature gate, 27 tests |
