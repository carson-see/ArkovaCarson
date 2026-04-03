# Phase 2: Agentic Layer — Product Requirements

> Source: Phase II Gap Analysis, Arkova-Master-Strategy-Complete
> Created: 2026-04-03 EST | Status: NOT STARTED

---

## Overview

Phase 2 builds the Agentic Layer on top of the Phase 1.5 verification and data infrastructure. The goal is to make Arkova verification a first-class primitive for autonomous AI agents: agents can verify credentials, anchor attestations, receive webhook notifications, and integrate Arkova into agent frameworks (LangChain, AutoGen, MCP).

Phase 3 placeholders establish the long-term direction toward jurisdiction-compliant electronic signatures and enterprise compliance tooling.

**Two phases, three workstreams:**

**Phase II — Agentic Layer (this document):**
1. **Audit & Anchoring** — Wire verification audit trails and attestation anchoring into the existing pipeline
2. **Agent API** — Oracle endpoint, webhook event triggers, agent identity model
3. **Framework Integrations** — LangChain tool, AutoGen adapter, MCP server enhancements

**Phase III — eSignature & Compliance (placeholders):**
4. **AdES Signatures** — Jurisdiction-compliant Advanced Electronic Signatures
5. **QTSP Integration** — Qualified Trust Service Provider timestamp tokens
6. **Compliance Center** — Customer-facing audit proof portal

---

## WORKSTREAM 1: AUDIT & ANCHORING

### PH2-AGENT-01: Verification Audit Trail
**Priority:** P0 | **Effort:** Small | **Depends on:** None

Currently, `/api/v1/verify/:publicId` calls are silent — no record of who queried what. This story logs every verification call to `audit_events` with the querying agent/user identity, result, and timestamp.

**Files:** `services/worker/src/api/v1/verify.ts`, migration for new audit event type

**Acceptance Criteria:**
- [ ] Every `/api/v1/verify/:publicId` call inserts a row into `audit_events`
- [ ] Logged fields: `querying_agent_id` (from API key), `public_id` queried, verification result (pass/fail), timestamp
- [ ] New audit event type `VERIFICATION_QUERY` added via migration
- [ ] Batch verify endpoint (`/api/v1/verify/batch`) also logs per-item audit events
- [ ] Audit events queryable by admin via existing admin audit log UI
- [ ] No PII in audit event payload (Constitution 1.4 — actor_email already scrubbed)
- [ ] Unit tests with mocked Supabase client
- [ ] Rate limiting unchanged (existing limits apply)

### PH2-AGENT-02: Attestation Bitcoin Anchoring
**Priority:** P0 | **Effort:** Medium | **Depends on:** None

The `attestations` table has an `anchor_id` FK but no job creates the anchor. This story wires attestations into the existing anchor pipeline so that attestations get Bitcoin-anchored like credentials.

**Files:** `services/worker/src/jobs/anchor-attestations.ts`

**Acceptance Criteria:**
- [ ] New cron job `processAttestationAnchoring()` queries `attestations WHERE anchor_id IS NULL`
- [ ] For each unanchored attestation, creates an anchor record with fingerprint derived from attestation content
- [ ] Attestation fingerprint = SHA-256 of canonical JSON (attestation_type + subject_id + claims + created_at)
- [ ] Merkle batch anchoring supported (reuses existing `batch-anchor.ts` infrastructure)
- [ ] `attestations.anchor_id` linked after successful anchor creation
- [ ] Anchor lifecycle follows existing state machine (PENDING -> SUBMITTED -> SECURED)
- [ ] Switchboard flag: `ENABLE_ATTESTATION_ANCHORING` (default: `false`)
- [ ] Unit tests with MockChainClient
- [ ] TLA+ model unchanged (attestation anchors follow same lifecycle)

---

## WORKSTREAM 2: AGENT API

### PH2-AGENT-03: Webhook Event Triggers
**Priority:** P1 | **Effort:** Medium | **Depends on:** PH2-AGENT-02

Infrastructure exists (`webhook_endpoints`, `webhook_delivery_logs` tables) but no job emits events when anchor status changes or attestations are created/verified. This story wires webhook delivery for key lifecycle events.

**Files:** `services/worker/src/jobs/webhook-dispatch.ts`

**Acceptance Criteria:**
- [ ] New job `dispatchWebhookEvents()` triggered after anchor status transitions
- [ ] Events emitted for: `anchor.secured`, `anchor.revoked`, `attestation.created`, `attestation.verified`
- [ ] Webhook payload includes: event type, timestamp, public_id, relevant metadata
- [ ] Delivery logged in `webhook_delivery_logs` with HTTP status, retry count, response time
- [ ] Retry with exponential backoff: 3 attempts, 30s/120s/600s delays
- [ ] HMAC-SHA256 signature on webhook payload (using endpoint secret)
- [ ] Idempotency key in payload to prevent duplicate processing
- [ ] Dead letter handling: mark endpoint as unhealthy after 10 consecutive failures
- [ ] Switchboard flag: `ENABLE_WEBHOOK_DISPATCH` (default: `false`)
- [ ] Unit tests with mocked HTTP client

### PH2-AGENT-04: Record Authenticity Oracle
**Priority:** P1 | **Effort:** Large | **Depends on:** PH2-AGENT-01

Dedicated agent-callable endpoint that returns signed, auditable verification responses with agent metadata. Different from existing `/api/v1/verify/:publicId` — adds agent identity tracking, signed responses, and structured oracle output for agent consumption.

**Files:** `services/worker/src/api/v1/oracle.ts`, migration for `agent_verifications` table

**Acceptance Criteria:**
- [ ] New endpoint: `POST /api/v1/oracle/verify` accepting `{ public_id, agent_id, context? }`
- [ ] Response includes: verification result, Bitcoin anchor proof, timestamp, response signature (HMAC-SHA256)
- [ ] Response signature allows agents to prove they received an authentic Arkova verification
- [ ] `agent_verifications` table logs: agent_id, public_id, result, response_hash, created_at
- [ ] Migration with RLS: agents can only read their own verification history
- [ ] x402 payment integration ($0.005/call) — or API key auth
- [ ] Rate limited: 500 req/min per agent
- [ ] OpenAPI spec updated with oracle endpoint
- [ ] Unit tests with mocked chain client and Supabase

### PH2-AGENT-05: Agent Identity & Delegation
**Priority:** P2 | **Effort:** XL | **Depends on:** PH2-AGENT-04

Agent registration, capability model, and delegation chains. Agents get API keys with scoped permissions. Enables enterprise customers to issue sub-agent keys with limited capabilities.

**Files:** migration for `agents` table, `services/worker/src/api/v1/agents.ts`

**Acceptance Criteria:**
- [ ] Migration: `agents` table with columns: id, org_id, name, description, capabilities (JSONB), parent_agent_id (nullable, for delegation), status, created_at
- [ ] RLS: org members can manage their org's agents; agents cannot see other orgs' agents
- [ ] Three capability scopes: `read-verify`, `write-attest`, `admin`
- [ ] Agent registration endpoint: `POST /api/v1/agents` (org admin only)
- [ ] Agent API key issuance: `POST /api/v1/agents/:id/keys` (HMAC-SHA256 hashed, raw key returned once)
- [ ] Delegation: agent A can create sub-agent B with subset of A's capabilities
- [ ] Delegation chain depth limit: 3 levels
- [ ] Agent deactivation: `DELETE /api/v1/agents/:id` — revokes all keys, cascades to sub-agents
- [ ] Audit trail: all agent CRUD operations logged to `audit_events`
- [ ] Unit tests for capability validation, delegation chain limits, key lifecycle

### PH2-AGENT-06: Agent Framework Integrations
**Priority:** P2 | **Effort:** Large | **Depends on:** PH2-AGENT-04, PH2-AGENT-05

Make Arkova verification a native tool in popular agent frameworks. LangChain tool, AutoGen integration, and MCP server enhancement.

**Files:** `sdks/langchain/`, `services/edge/src/mcp-server.ts` enhancements

**Acceptance Criteria:**
- [ ] LangChain tool: `ArkovaVerifyTool` — wraps oracle endpoint, returns structured verification result
- [ ] LangChain tool: `ArkovaAttestTool` — creates attestation via API
- [ ] LangChain tool published as `@arkova/langchain` npm package
- [ ] AutoGen integration: function definitions for verify + attest + search
- [ ] MCP server tools added: `oracle_verify`, `create_attestation`, `list_agent_verifications`
- [ ] MCP server tools use agent API key from context (no hardcoded keys)
- [ ] README with examples for each framework (LangChain, AutoGen, MCP)
- [ ] Integration tests with mocked API responses

---

## PHASE III PLACEHOLDERS (eSignature & Compliance)

> These stories are placeholders for Phase III planning. No implementation until Phase II Gate 2 criteria met.

### PH3-ESIG-01: AdES Signature Engine
**Priority:** P0 (Phase III) | **Effort:** XL | **Depends on:** Phase II complete

Jurisdiction-compliant Advanced Electronic Signatures with PKI and timestamp embedding. ETSI EN 319 401/411-1 aligned. Enables Arkova-anchored documents to carry legally binding electronic signatures recognized in EU (eIDAS), US (ESIGN/UETA), and other jurisdictions.

**Acceptance Criteria:**
- [ ] XAdES (XML Advanced Electronic Signatures) support for structured documents
- [ ] PAdES (PDF Advanced Electronic Signatures) support for PDF documents
- [ ] CAdES (CMS Advanced Electronic Signatures) support for arbitrary binary
- [ ] Long-term validation (LTV) data embedded in signatures
- [ ] PKI certificate chain validation
- [ ] Timestamp embedding from qualified timestamp authority
- [ ] Signature level support: B-B, B-T, B-LT, B-LTA
- [ ] Integration with Bitcoin anchor proof (dual evidence: PKI signature + blockchain timestamp)
- [ ] Jurisdiction tag mapping to applicable signature requirements

### PH3-ESIG-02: QTSP Integration
**Priority:** P1 (Phase III) | **Effort:** XL | **Depends on:** PH3-ESIG-01

Qualified Trust Service Provider timestamp tokens per RFC 3161 and ETSI EN 319 421/422. Provides legally recognized timestamps from accredited TSAs alongside Bitcoin anchoring.

**Acceptance Criteria:**
- [ ] RFC 3161 timestamp token request/response implementation
- [ ] Integration with at least 2 QTSPs (e.g., DigiCert, Sectigo)
- [ ] Timestamp token embedded in AdES signatures (PH3-ESIG-01)
- [ ] Dual timestamp evidence: QTSP token + Bitcoin anchor
- [ ] QTSP failover: if primary TSA unavailable, fall back to secondary
- [ ] Timestamp token validation endpoint for third-party verification
- [ ] Cost tracking: per-timestamp pricing from QTSP providers
- [ ] ETSI EN 319 422 compliance validation

### PH3-ESIG-03: Compliance Center
**Priority:** P1 (Phase III) | **Effort:** Large | **Depends on:** PH3-ESIG-01, CML-03

Customer-facing portal for audit proofs, policy transparency, and SOC 2 evidence bundles. Enables enterprise customers to self-serve compliance documentation.

**Acceptance Criteria:**
- [ ] Customer-facing `/compliance` dashboard (separate from admin)
- [ ] Audit proof download: per-credential and bulk export
- [ ] Policy transparency: public display of data handling, retention, encryption policies
- [ ] SOC 2 evidence bundle generation (builds on CML-03 audit export)
- [ ] GDPR Article 30 record of processing activities export
- [ ] Compliance score per organization (based on credential coverage + anchoring status)
- [ ] Scheduled compliance report delivery (email + webhook)
- [ ] Role-based access: compliance officer role within organization

---

## DEPENDENCY MAP

```
PH2-AGENT-01 (Audit Trail) ──────── PH2-AGENT-04 (Oracle)
                                          │
PH2-AGENT-02 (Attest Anchor) ──── PH2-AGENT-03 (Webhooks)
                                          │
PH2-AGENT-04 ─────────────────┬── PH2-AGENT-05 (Agent Identity)
                               └── PH2-AGENT-06 (Framework Integrations)

PH2-AGENT-05 ─────────────────── PH2-AGENT-06

--- Phase III ---

Phase II complete ────────────── PH3-ESIG-01 (AdES Engine)
                                      │
PH3-ESIG-01 ──────────────────── PH3-ESIG-02 (QTSP)
PH3-ESIG-01 + CML-03 ─────────── PH3-ESIG-03 (Compliance Center)
```

---

## KNOWN RISKS

1. **Webhook delivery reliability** — High-volume webhook dispatch may overwhelm subscriber endpoints. Mitigation: rate limiting per endpoint, circuit breaker pattern.
2. **Agent delegation complexity** — Deep delegation chains create authorization complexity. Mitigation: depth limit of 3, capability intersection only (no escalation).
3. **Oracle response signing** — HMAC-SHA256 provides integrity but not non-repudiation. For legal-grade non-repudiation, Phase III AdES signatures are needed.
4. **LangChain API stability** — LangChain tool interfaces change frequently. Mitigation: pin to specific LangChain version, abstract tool interface.
5. **Attestation volume** — If attestation anchoring generates high anchor volume, Bitcoin fees may spike. Mitigation: Merkle batching (existing), fee ceiling (PERF-7).
6. **Agent key sprawl** — Organizations may create many agent keys. Mitigation: key rotation reminders, usage analytics, deactivation cascade.

---

## SPRINT PLAN

### Sprint PH2-S1: Foundation (Days 1-3)
- PH2-AGENT-01: Verification audit trail
- PH2-AGENT-02: Attestation Bitcoin anchoring

### Sprint PH2-S2: Events & Oracle (Days 4-7)
- PH2-AGENT-03: Webhook event triggers
- PH2-AGENT-04: Record authenticity oracle

### Sprint PH2-S3: Agent Model & Integrations (Days 8-14)
- PH2-AGENT-05: Agent identity & delegation
- PH2-AGENT-06: Agent framework integrations

### Phase III — Deferred until Gate 2
- PH3-ESIG-01, PH3-ESIG-02, PH3-ESIG-03

---

## DECISION GATES

| Gate | Timing | Criteria | If Yes | If No |
|------|--------|----------|--------|-------|
| Gate 1 | Phase II Sprint 2 complete | >5 agents registered, webhook delivery >95% success rate | Proceed to Sprint 3 (agent identity) | Extend S1-S2, focus on reliability |
| Gate 2 | Phase II complete | >50 active agents, >10K oracle calls/mo, enterprise demand signal | Begin Phase III (eSignatures) | Optimize Phase II, defer Phase III |
