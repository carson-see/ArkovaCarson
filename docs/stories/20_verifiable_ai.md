# Story Group 20: Verifiable AI (VAI) — Phase III Roadmap
_Created: 2026-03-29 | Source: [Strategic Blueprint — The Immutable Compliance Fabric](https://docs.google.com/document/d/1yLGX5zJ6xWu_J2J-510n0yQZZe9YfzLTK_h7wm3mqyQ/edit)_

## Overview

Position Arkova as the "Audit-Defense" layer for the AI economy. Provide **Computational Integrity** — ensuring AI-driven decisions are anchored to an immutable audit trail.

**Defensive Moat:** Algorithmic Non-Repudiation — the "White Box" for AI. We log the relationship between Source Document → AI Extraction → Blockchain Anchor. The "Nessie Protocol" cryptographically binds every extraction to its source, preventing "hallucination drift" and ensuring legal admissibility.

**Commercial Impact:** Justifies $200k/year Enterprise Attestation tier. Moves from per-verification cost to "System of Record" for AI liability.
**Target:** Chief Risk Officer (CRO)
**Jira Epic:** SCRUM-264

## Stories

### VAI-01: Verifiable Extraction — Cryptographic Binding of AI Output
**Jira:** SCRUM-270 | **Priority:** HIGH | **Effort:** L | **Status:** COMPLETE
**Dependencies:** Existing AI extraction pipeline (P8 AI Intelligence)

Cryptographically bind every AI extraction to source document hash and anchor to Bitcoin.

**Deliverables:**
- ✅ Signed extraction manifest: `{source_hash, model_id, model_version, extraction_timestamp, extracted_fields[], confidence_scores[]}`
- ✅ `extraction_manifests` table (migration 0138)
- ✅ Manifest hash in anchor metadata (`_extraction_manifest_hash`)
- ✅ Queryable provenance chain: `GET /api/v1/ai/provenance/:fingerprint`
- ✅ Both Nessie and Gemini produce compatible manifests (modelVersion on ExtractionResult)
- ✅ Frontend ExtractionOutput includes manifestHash
- ✅ 19 unit tests (13 manifest + 6 provenance)

### VAI-02: ZK-STARK Evidence Packages
**Jira:** SCRUM-271 | **Priority:** MEDIUM | **Effort:** XL | **Status:** NOT STARTED
**Dependencies:** VAI-01

Zero-Knowledge proofs to verify AI model execution without exposing raw data. Following Eli Ben-Sasson's "Integrity as a Service" model.

**Deliverables:**
- Research spike: evaluate Cairo/StarkNet, risc0, SP1
- Proof-of-concept for simple extraction step
- ZK proof attached to extraction manifest
- Browser-side WASM verifier
- Performance target: < 30 seconds per document

**Note:** Research-heavy. This is long-term core IP and the primary defensive moat.

### VAI-03: AI Accountability Report — One-Click Provenance Export
**Jira:** SCRUM-272 | **Priority:** HIGH | **Effort:** M | **Status:** COMPLETE
**Dependencies:** VAI-01

One-click export showing complete AI provenance: [Source Hash] → [Gemini/Nessie Version] → [Human Override Log] → [On-Chain Anchor].

**Deliverables:**
- ✅ `POST /api/v1/ai-accountability-report` endpoint (PDF + JSON formats)
- ✅ PDF with 5 sections: Document Info, Cryptographic Proof, AI Provenance Chain, Lifecycle Timeline, Disclaimers
- ✅ JSON format with structured provenance chain, compliance controls, lifecycle events
- ✅ Source hash, model ID + version, confidence scores, manifest hash, Bitcoin TX + block
- ✅ Audit events as lifecycle timeline
- ✅ 7 unit tests (auth, validation, PDF, JSON, audit events, no-manifest handling)
- **Deferred:** Batch generation (can use CML-03 batch endpoint for bulk)

### VAI-04: Auditor Mode Toggle — Enterprise Auditor View
**Jira:** SCRUM-273 | **Priority:** HIGH | **Effort:** S | **Status:** COMPLETE
**Dependencies:** None

"Auditor Mode" toggle — low-effort, high-impact Enterprise feature.

**Deliverables:**
- `src/hooks/useAuditorMode.ts` — Context + hook, localStorage-persisted, audit event on toggle
- Toggle in sidebar footer (ShieldCheck icon, "ON" indicator when active)
- `src/components/layout/AppShell.tsx` — Cyan banner "Auditor Mode — Read-only compliance view"
- `src/components/anchor/SecureDocumentDialog.tsx` — Suppressed in auditor mode (returns null)
- `src/App.tsx` — AuditorModeContext.Provider wrapping entire app
- Audit events logged: `auditor_mode_enabled` / `auditor_mode_disabled`
- **Deferred:** Shareable time-limited auditor link, AUDITOR role (follow-up scope)

### VAI-05: Sales Deck & GTM — "Audit-Defense" Positioning
**Jira:** SCRUM-274 | **Priority:** MEDIUM | **Effort:** S | **Status:** NOT STARTED
**Dependencies:** None

Update sales materials with "Audit-Defense" and "Integrity as a Service" narrative.

**Deliverables:**
- Updated sales deck
- Competitive positioning: GRC vs Identity/Verify vs AI Wrappers vs Arkova
- "Computational Integrity" investor one-pager
- Case study template: audit prep time reduction
- Landing page copy for CRO/GRC
- All content passes Marketing/Docs DoD

## GTM Competitive Wedge

| Competitor Type | Their Weakness | Arkova's Angle |
|----------------|----------------|----------------|
| Traditional GRC | Manual evidence collection; high friction | Automated, immutable evidence anchoring |
| Identity/Verify Tools | Centralized "Trust me" databases | Decentralized "Verify the Math" protocol |
| Generic AI Wrappers | Hallucinations; no audit trail | Computational Integrity via Gemini or Nessie |

## Status Summary

| Story | Status | Priority |
|-------|--------|----------|
| VAI-01 | COMPLETE | HIGH |
| VAI-02 | NOT STARTED | MEDIUM |
| VAI-03 | COMPLETE | HIGH |
| VAI-04 | COMPLETE | HIGH |
| VAI-05 | NOT STARTED | MEDIUM |

## Change Log

| Date | Change |
|------|--------|
| 2026-03-29 | Initial creation from Strategic Blueprint document |
| 2026-03-29 | VAI-04 COMPLETE — Auditor mode toggle (useAuditorMode hook, sidebar, AppShell banner, SecureDocumentDialog suppressed) |
| 2026-03-29 | VAI-01 COMPLETE — Extraction manifests (migration 0138, manifest hash, provenance endpoint, 19 tests) |
| 2026-03-29 | VAI-03 COMPLETE — AI accountability report (PDF + JSON, provenance chain, lifecycle timeline, 7 tests) |
