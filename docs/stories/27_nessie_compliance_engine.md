# Story Group 27: Nessie Compliance Engine — From Intelligence Model to "Compliance Copilot"

> **Created:** 2026-04-09 | **Epic:** Nessie Compliance Engine (NCE)
> **Jira Epic:** SCRUM-590 | **Stories:** SCRUM-591–611 | **Priority:** P0 — Strategic
> **Depends on:** NMT-07 (intelligence pipeline), Phase 1.5 RAG infrastructure, 320K+ public records corpus
> **Strategy docs:** Arkova-Verified-Intelligence-SLM-Analysis, Strategic Blueprint — The Immutable Compliance Fabric, Verification Bootstrap Strategy

---

## Vision

**Nessie becomes the compliance copilot every organization needs.** She reads your anchored documents, understands your jurisdiction, identifies what's missing, and gives you a real-time compliance score — all backed by Bitcoin-anchored evidence that no other AI can claim.

The competitive moat: every answer Nessie gives traces back to cryptographically verified source documents. No hallucinations. No "trust me" — verify the math.

### What This Unlocks

| Capability | User Value | Revenue Impact |
|-----------|-----------|----------------|
| **Compliance Score** | "You're 72% compliant for California" | Differentiator for Professional ($49/mo) |
| **Gap Analysis** | "You're missing a W-9 and professional liability insurance" | Drives document uploads → more anchors |
| **Proactive Alerts** | "Your CPA license expires in 30 days" | Retention + upsell from Individual → Professional |
| **Jurisdiction Intelligence** | "In Texas, you also need Form XYZ" | Organization tier differentiator (custom pricing) |
| **Audit-Ready Reports** | One-click SOC 2 / FERPA / HIPAA evidence bundle | Organization tier — enterprise sales driver |
| **Benchmarking** | "Orgs in your industry average 89% — you're at 72%" | Competitive pressure → upgrades |

### Architecture: How Nessie Gets Smart

```
┌─────────────────────────────────────────────────────────────┐
│                    USER'S ANCHORED DOCUMENTS                │
│  Degrees, Licenses, Certs, SEC Filings, Transcripts, etc.  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              NESSIE COMPLIANCE ENGINE                         │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Jurisdiction │  │   Gap        │  │  Compliance       │  │
│  │ Rule Engine  │  │   Detector   │  │  Score Calculator │  │
│  │              │  │              │  │                   │  │
│  │ "CA requires │  │ "Missing:    │  │  Score: 72/100    │  │
│  │  these docs" │  │  W-9, InsLic"│  │  ▓▓▓▓▓▓▓░░░      │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                    │             │
│         ▼                 ▼                    ▼             │
│  ┌──────────────────────────────────────────────────┐       │
│  │           RAG + Public Records Corpus             │       │
│  │  320K+ records: SEC, USPTO, CourtListener,        │       │
│  │  Federal Register, DAPIP, NPI, CalBar, OpenAlex   │       │
│  │  + 1.41M+ user-anchored documents                 │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │           Bitcoin Anchor Verification              │       │
│  │  Every citation → chain_tx_id → mempool link      │       │
│  │  "This recommendation is backed by evidence"       │       │
│  └──────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    USER-FACING OUTPUT                         │
│                                                              │
│  Dashboard: Compliance Score + Gap List + Recommendations    │
│  API: /api/v1/nessie/compliance-score                        │
│  Alerts: Email + webhook when score changes                  │
│  Reports: PDF audit-ready compliance bundle                  │
└──────────────────────────────────────────────────────────────┘
```

---

## What's Already Built (Foundation)

| Component | Status | Location |
|-----------|--------|----------|
| Nessie v5 extraction model (87.2% F1) | COMPLETE | services/worker/src/ai/nessie.ts |
| 5 intelligence modes (qa, risk, summary, recommend, cross-ref) | COMPLETE | services/worker/src/ai/prompts/intelligence.ts |
| Intelligence training data pipeline | IN PROGRESS (NMT-07) | services/worker/src/ai/training/nessie-intelligence-data.ts |
| RAG with hybrid search (BM25 + dense + RRF) | COMPLETE | services/worker/src/ai/hybrid-search.ts |
| Nessie query API (retrieval + context modes) | COMPLETE | services/worker/src/api/v1/nessie-query.ts |
| 320K+ public records with 13 fetchers | COMPLETE | services/worker/src/jobs/*Fetcher.ts |
| pgvector embeddings infrastructure | COMPLETE | migrations 0051, 0060, 0077, 0080 |
| Domain routing (4 LoRA adapters) | COMPLETE | services/worker/src/ai/nessie-domain-router.ts |
| Confidence calibration pipeline | COMPLETE | services/worker/src/ai/eval/calibration.ts |
| Extraction manifest + provenance chain | COMPLETE | services/worker/src/ai/extraction-manifest.ts |
| Compliance mapping layer (5 stories) | COMPLETE | CML-01 through CML-05 |
| Review queue (human-in-the-loop) | COMPLETE | services/worker/src/ai/review-queue.ts |
| Report generator (4 report types) | COMPLETE | services/worker/src/ai/report-generator.ts |
| Gemini Golden v2 finetune script | READY | services/worker/scripts/gemini-golden-finetune.ts |

---

## Phase 1: Train the Intelligence Model (Weeks 1-3)

> **Goal:** Nessie can answer compliance questions with verified citations. Prerequisite for everything else.

### NCE-01: Enable Embedding Corpus (P0 — Ops)
**Effort:** Small (1 day) | **Dependencies:** GEMINI_API_KEY with embedding quota

Turn on the embedding pipeline so Nessie has documents to reason over.

**Acceptance Criteria:**
- [ ] Set `ENABLE_PUBLIC_RECORD_EMBEDDINGS=true` in Cloud Run env
- [ ] Run `embedPublicRecords()` job — generate embeddings for 320K+ records
- [ ] Verify: `GET /api/v1/nessie/query?q=SEC+10-K+filing&mode=retrieval` returns ranked results with anchor proofs
- [ ] Monitor Gemini embedding API costs (budget: ~$50 for 320K records)
- [ ] Verify hybrid search (BM25 + dense) returns higher-quality results than dense-only

**Why this is first:** Nessie can't reason about compliance without a searchable corpus. Everything downstream depends on this.

---

### NCE-02: Gemini Golden v2 Retrain (P0 — Ops)
**Effort:** Small (1 day, parallel with NCE-01) | **Dependencies:** Vertex AI access

Retrain Gemini Golden on the full 1,605-entry dataset (currently trained on 1,314 — missing phases 10-11 and has hardcoded confidence).

**Acceptance Criteria:**
- [ ] Run `npx tsx scripts/gemini-golden-finetune.ts --dry-run` — validate 1,605 entries
- [ ] Submit Vertex AI tuning job (estimated ~$50, 8 epochs)
- [ ] Evaluate against full golden dataset (target: >92% weighted F1, up from 90.4%)
- [ ] If improved: update `GEMINI_TUNED_MODEL` endpoint in Cloud Run
- [ ] Log results in `docs/eval/`

**Why:** Better extraction feeds better intelligence. The 291 missing training examples include gap-closure types (RESUME, CLE, PATENT, MILITARY) that Nessie intelligence will need to reason about.

---

### NCE-03: Distill Intelligence Training Data (P0 — Engineering)
**Effort:** Large (1-2 weeks) | **Dependencies:** NCE-01 (corpus enabled)

Use Gemini as teacher to generate high-quality compliance intelligence training data. This is the core engineering work that enables Nessie's pivot from extraction to intelligence.

**Acceptance Criteria:**
- [ ] Select 200 diverse public records from each of 5 domains (SEC, USPTO, CourtListener, Federal Register, OpenAlex)
- [ ] For each record, generate 3-5 intelligence queries across all 5 task types
- [ ] Feed queries + record context to Gemini with intelligence system prompts
- [ ] Gemini generates teacher responses with analysis + verified citations + risks + recommendations
- [ ] Validate: all citations reference actual documents in corpus (reject hallucinated citations)
- [ ] Cross-model verification: validate 10% subset with a second model
- [ ] Human spot-check: 5-10% manual review
- [ ] Distribution balanced across task types and domains
- [ ] Target: 1,000-1,500 validated intelligence examples
- [ ] Export as Together AI JSONL format

**Domain Distribution:**

| Domain | Examples | Primary Task Types |
|--------|----------|-------------------|
| SEC / Financial | 250 | compliance_qa, risk_analysis, document_summary |
| Legal / Court | 200 | compliance_qa, cross_reference, recommendation |
| Regulatory | 200 | compliance_qa, recommendation, document_summary |
| Patent / IP | 150 | cross_reference, risk_analysis, document_summary |
| Academic | 100 | risk_analysis, cross_reference, document_summary |
| General mix (25%) | 250 | All types (prevents catastrophic forgetting) |
| **Total** | **1,150** | |

**New distillation script:** `services/worker/scripts/nessie-intelligence-distill.ts`

---

### NCE-04: Fine-Tune Nessie Intelligence v1 (P0 — Engineering)
**Effort:** Medium (1 week) | **Dependencies:** NCE-03

Fine-tune Nessie on intelligence data via Together AI. This is where Nessie learns to be a compliance analyst instead of an extraction engine.

**Training Config (per Best Practices doc):**
- Base: Llama 3.1 8B Instruct
- LoRA rank: 32 (higher than extraction's 16 — compliance reasoning is more complex)
- Alpha: 64 (2x rank)
- LR: 2e-4 with cosine decay
- Epochs: 2 (>3 causes overfitting)
- Batch: 2 x 8 grad accumulation = effective 16
- bf16 precision
- 25% general instruction data mix

**Acceptance Criteria:**
- [ ] Export training data as Together AI JSONL
- [ ] Submit fine-tune job to Together AI
- [ ] Deploy to RunPod for evaluation (A6000 48GB)
- [ ] CRITICAL: Use intelligence system prompt at inference (NOT extraction prompt — mismatch = 0% F1)
- [ ] Citation accuracy >95% on held-out test set
- [ ] Faithfulness >0.90 (claims supported by retrieved context)
- [ ] Latency P95 <5s

---

### NCE-05: Intelligence Evaluation Benchmark (P0 — Engineering)
**Effort:** Medium (3-5 days) | **Dependencies:** NCE-04

Build a compliance intelligence evaluation benchmark, separate from extraction F1.

**Metrics:**

| Metric | Target | Description |
|--------|--------|-------------|
| Citation accuracy | >95% | Do citations reference actual documents? |
| Faithfulness | >0.90 | Are claims supported by retrieved context? |
| Answer relevance | >0.85 | Does the answer address the query? |
| Risk detection recall | >80% | Does it find known risks in test cases? |
| Recommendation quality | >3.5/5 | Expert review of usefulness |
| Confidence correlation | r > 0.60 | Does confidence predict answer quality? |
| Latency P95 | <5s | Time to generate intelligence response |

**Acceptance Criteria:**
- [ ] 100 expert-annotated Q&A pairs (20 per domain)
- [ ] Automated scoring pipeline (reuses eval/runner.ts pattern)
- [ ] Comparison: Nessie Intelligence vs raw Gemini on same queries
- [ ] Results documented in `docs/eval/`
- [ ] If targets met: promote to production default for intelligence queries

---

## Phase 2: Compliance Scoring Engine (Weeks 3-5)

> **Goal:** Nessie reads your anchored documents and gives you a compliance score with specific gaps identified.

### NCE-06: Jurisdiction Rule Engine (P0 — Engineering)
**Effort:** Large | **Dependencies:** NCE-04 (intelligence model)

Build a rule engine that knows what documents are required for compliance in specific jurisdictions and industries. This is the backbone of Nessie's compliance scoring.

**Acceptance Criteria:**
- [ ] New table: `jurisdiction_rules` — stores per-jurisdiction document requirements
- [ ] Schema: `{ jurisdiction_code, industry_code, rule_name, required_credential_types[], optional_credential_types[], regulatory_reference, effective_date, expiry_date }`
- [ ] Seed with initial rules for 10 US states (CA, NY, TX, FL, IL, PA, OH, GA, NC, MI)
- [ ] Rule categories: professional licensing, corporate compliance, educational credentials, employment verification
- [ ] Nessie can query rules: "What does California require for a licensed CPA?"
- [ ] Rules cite regulatory sources (public record IDs where available)
- [ ] RLS: rules are public (read-all), admin-only write
- [ ] Migration + rollback + types + seed
- [ ] API: `GET /api/v1/compliance/rules?jurisdiction=CA&industry=accounting`

**Initial Jurisdiction Rules (Phase 1 — 10 states):**

| Jurisdiction | Industry | Required Documents |
|-------------|----------|-------------------|
| California | CPA | CPA License, Continuing Education (80hrs/2yr), Ethics Course |
| California | Attorney | Bar Admission, MCLE (25hrs/yr), Good Standing Certificate |
| California | Nurse | RN License, BLS Certification, CEU (30hrs/2yr) |
| New York | CPA | CPA License, CE (40hrs/yr), Ethics (4hrs/yr) |
| Texas | Engineer | PE License, CE (15 PDH/yr), Ethics (1hr/yr) |
| Florida | Real Estate | Active License, CE (14hrs/2yr), Post-License (45hrs first renewal) |
| ... | ... | ... |

---

### NCE-07: Compliance Score Calculator (P0 — Engineering)
**Effort:** Large | **Dependencies:** NCE-06 (jurisdiction rules)

The crown jewel: Nessie reads your anchored documents, compares them against jurisdiction requirements, and calculates a real-time compliance score.

**Acceptance Criteria:**
- [ ] New table: `compliance_scores` — stores per-org, per-jurisdiction scores
- [ ] Schema: `{ org_id, user_id, jurisdiction_code, industry_code, score (0-100), missing_documents[], expiring_documents[], last_calculated, nessie_analysis_id }`
- [ ] Score algorithm:
  - Start at 0
  - +points for each required document present and anchored (SECURED)
  - +bonus for documents with high integrity scores (>0.85)
  - -penalty for expired documents
  - -penalty for documents with fraud flags
  - Weight by document importance (license > CE credits)
- [ ] Nessie intelligence generates the analysis (which docs are present, what's missing, what's expiring)
- [ ] Score recalculated on: new anchor SECURED, document revoked, document expired, rule change
- [ ] API: `GET /api/v1/compliance/score?jurisdiction=CA&industry=accounting`
- [ ] Response includes: score, grade (A/B/C/D/F), missing_documents[], recommendations[], expiring_within_90_days[]
- [ ] Each recommendation backed by Nessie citation (anchor proof link)

**Score Breakdown Example:**
```json
{
  "score": 72,
  "grade": "C",
  "jurisdiction": "CA",
  "industry": "accounting",
  "summary": "You have 7 of 10 required documents for California CPA compliance.",
  "present": [
    { "type": "CPA_LICENSE", "status": "SECURED", "anchor_tx": "abc123...", "expires": "2027-06-15" },
    { "type": "DEGREE", "status": "SECURED", "anchor_tx": "def456..." }
  ],
  "missing": [
    { "type": "ETHICS_COURSE", "requirement": "80hrs/2yr cycle", "regulatory_ref": "CA Bus & Prof Code §5026" },
    { "type": "CONTINUING_EDUCATION", "requirement": "Current cycle", "deadline": "2026-12-31" }
  ],
  "expiring_soon": [
    { "type": "CPA_LICENSE", "expires": "2027-06-15", "days_remaining": 432 }
  ],
  "recommendations": [
    {
      "action": "Upload your latest CE completion certificate",
      "impact": "+12 points",
      "citation": { "source": "CA Board of Accountancy", "record_id": "pub_rec_12345", "anchor_proof": "..." }
    }
  ]
}
```

---

### NCE-08: Gap Detector — "What's Missing?" (P0 — Engineering)
**Effort:** Medium | **Dependencies:** NCE-07 (score calculator)

Nessie proactively identifies missing documents by comparing an org's anchored records against jurisdiction requirements and similar orgs in the same industry.

**Acceptance Criteria:**
- [ ] `POST /api/v1/nessie/gap-analysis` — accepts org_id + jurisdiction + industry
- [ ] Nessie reads all org's anchored documents (via Supabase query, RLS-scoped)
- [ ] Compares against jurisdiction_rules for the specified context
- [ ] Also compares against anonymized aggregate data: "85% of CA CPAs also have X"
- [ ] Returns: missing_required[], missing_recommended[], priority_order[]
- [ ] Each gap includes: what's needed, why (regulatory citation), how much it improves score, deadline if applicable
- [ ] Nessie generates natural language summary: "You're missing 3 critical documents for California CPA compliance..."
- [ ] Webhook: `compliance.gap_detected` fires when new gaps found after score recalc
- [ ] Unit tests with realistic org data

---

### NCE-09: Expiry & Renewal Alerts (P1 — Engineering)
**Effort:** Medium | **Dependencies:** NCE-07

Proactive alerts when documents are approaching expiration, using Nessie intelligence to recommend renewal actions.

**Acceptance Criteria:**
- [ ] New cron job: `checkExpiringCredentials()` — runs daily
- [ ] Queries all anchored documents with `expiry_date` within configurable windows (90, 60, 30, 7 days)
- [ ] For each expiring document, Nessie generates renewal guidance: what to do, where to go, impact on compliance score
- [ ] Email notification via Resend (reuse BETA-03 email infrastructure)
- [ ] Webhook: `compliance.document_expiring` with days_remaining, renewal_guidance
- [ ] Dashboard widget: "Expiring Soon" card on org dashboard
- [ ] Switchboard flag: `ENABLE_EXPIRY_ALERTS` (default: `false`)
- [ ] No PII in alert payloads (Constitution 1.4)

---

## Phase 3: Frontend Intelligence UI (Weeks 5-7)

> **Goal:** Users can talk to Nessie, see their compliance score, and act on recommendations.

### NCE-10: Compliance Dashboard (P0 — Frontend)
**Effort:** Large | **Dependencies:** NCE-07 (score calculator), NCE-08 (gap detector)

The primary user-facing surface for Nessie intelligence. Shows compliance score, gaps, recommendations, and expiring documents at a glance.

**Acceptance Criteria:**
- [ ] New page: `/compliance` (route in `src/lib/routes.ts`)
- [ ] Compliance Score gauge (0-100, color-coded: green >80, yellow 60-80, red <60)
- [ ] Grade badge (A/B/C/D/F)
- [ ] Jurisdiction selector (dropdown, defaults to org's primary jurisdiction)
- [ ] Industry selector (dropdown)
- [ ] "Missing Documents" card — list with "Upload Now" CTAs that link to Secure Document flow
- [ ] "Expiring Soon" card — timeline view of upcoming expirations
- [ ] "Recommendations" card — Nessie's prioritized action items with impact scores
- [ ] Each recommendation shows citation source with anchor proof link
- [ ] Score history chart (line graph, last 90 days)
- [ ] Mobile-responsive (375px viewport)
- [ ] Loading skeletons during data fetch
- [ ] Brand-compliant: DM Sans, Precision Engine design system
- [ ] E2E spec: `e2e/compliance-dashboard.spec.ts`

---

### NCE-11: Nessie Chat Interface (P1 — Frontend)
**Effort:** Large | **Dependencies:** NCE-04 (intelligence model deployed)

Users can ask Nessie compliance questions directly. Chat-style interface with inline citations.

**Acceptance Criteria:**
- [ ] New component: `src/components/nessie/NessieChat.tsx`
- [ ] Chat input with mode selector (Ask a Question / Analyze Risk / Get Recommendations)
- [ ] Streaming response display (or progressive loading)
- [ ] Inline citations: clickable `[1]` markers linking to source documents
- [ ] Citation cards: show document title, type, anchor proof (tx hash + explorer link), verify URL
- [ ] Confidence indicator on each response
- [ ] Risk badges (HIGH/MEDIUM/LOW) on risk analysis responses
- [ ] Conversation history (session-scoped, not persisted)
- [ ] Rate limiting UI: show remaining queries
- [ ] Accessible from: compliance dashboard, sidebar nav, record detail page
- [ ] Mobile-responsive
- [ ] E2E spec: `e2e/nessie-chat.spec.ts`

---

### NCE-12: Compliance Score Widget on Org Dashboard (P1 — Frontend)
**Effort:** Small | **Dependencies:** NCE-07, NCE-10

Add compliance score summary to the existing organization dashboard as a card.

**Acceptance Criteria:**
- [ ] New component: `ComplianceScoreCard` in org dashboard
- [ ] Shows: score (large number), grade badge, jurisdiction, "X of Y documents" progress bar
- [ ] "View Details" link to `/compliance`
- [ ] "X documents expiring soon" warning if applicable
- [ ] Graceful empty state if no jurisdiction configured
- [ ] Tests

---

## Phase 4: DPO + Advanced Training (Weeks 6-8)

> **Goal:** Make Nessie's intelligence responses production-grade through preference training and specialized capabilities.

### NCE-13: DPO Training for Citation Accuracy (P1 — Engineering)
**Effort:** Large | **Dependencies:** NCE-05 (eval benchmark)

Direct Preference Optimization: train Nessie to prefer responses with accurate, verified citations over responses with hallucinated or missing citations.

**Acceptance Criteria:**
- [ ] Generate 500+ preference pairs: (query, chosen_response, rejected_response)
- [ ] "Chosen" responses: accurate citations, all claims grounded in retrieved context
- [ ] "Rejected" responses: hallucinated citations, unsupported claims, missing confidence
- [ ] Training via Together AI DPO pipeline
- [ ] Post-DPO eval: citation accuracy should improve from >95% to >98%
- [ ] Faithfulness should improve from >0.90 to >0.95

---

### NCE-14: Jurisdiction-Specific LoRA Adapters (P1 — Engineering)
**Effort:** Large | **Dependencies:** NCE-06 (jurisdiction rules), NCE-04

Train jurisdiction-specific LoRA adapters so Nessie has deep knowledge of specific regulatory environments.

**Acceptance Criteria:**
- [ ] 3 initial adapters: California, New York, Federal (SEC/IRS)
- [ ] Each adapter trained on jurisdiction-specific compliance Q&A
- [ ] Domain router extended to route by jurisdiction (in addition to credential type)
- [ ] Eval: jurisdiction-specific accuracy >90% on held-out test set
- [ ] Adapter switching at inference time (no model reload)

---

### NCE-15: Cross-Reference Engine — Document Consistency Checks (P1 — Engineering)
**Effort:** Medium | **Dependencies:** NCE-04

Nessie cross-references multiple documents from the same org/user to find inconsistencies (e.g., different names, conflicting dates, jurisdiction mismatches).

**Acceptance Criteria:**
- [ ] `POST /api/v1/nessie/cross-reference` — accepts list of anchor IDs
- [ ] Nessie compares extracted metadata across documents
- [ ] Flags: name mismatches, date conflicts, jurisdiction inconsistencies, duplicate credentials
- [ ] Returns severity-ranked list of findings
- [ ] Each finding includes the specific documents and fields that conflict
- [ ] Integration with review queue: HIGH severity findings auto-create review items
- [ ] Unit tests with realistic conflict scenarios

---

## Phase 5: Enterprise & Scale (Weeks 8-12)

> **Goal:** Nessie becomes a platform-level compliance intelligence service.

### NCE-16: Compliance API — Programmatic Access (P1 — Engineering)
**Effort:** Medium | **Dependencies:** NCE-07 (score), NCE-08 (gaps)

Full API for compliance scoring, gap analysis, and intelligence queries. Enables enterprise integrations and agent access.

**Acceptance Criteria:**
- [ ] `GET /api/v1/compliance/score` — returns score + breakdown
- [ ] `POST /api/v1/compliance/gap-analysis` — returns gaps + recommendations
- [ ] `POST /api/v1/compliance/cross-reference` — returns consistency findings
- [ ] `GET /api/v1/compliance/rules` — returns jurisdiction rules
- [ ] `GET /api/v1/compliance/history` — returns score history (30/60/90 days)
- [ ] All endpoints behind API key auth (existing infrastructure)
- [ ] Rate limiting: 100 req/min (API key tier)
- [ ] OpenAPI spec updated (`docs/api/openapi.yaml`)
- [ ] Metered billing integration (credits per query)

---

### NCE-17: Industry Benchmarking (P2 — Engineering)
**Effort:** Medium | **Dependencies:** NCE-07 (enough orgs using scoring)

Anonymous aggregate benchmarks: "How does your compliance score compare to others in your industry?"

**Acceptance Criteria:**
- [ ] Aggregate compliance scores by industry + jurisdiction (anonymized — no org identifiers)
- [ ] Minimum 5 orgs per benchmark bucket (privacy threshold)
- [ ] API: `GET /api/v1/compliance/benchmark?industry=accounting&jurisdiction=CA`
- [ ] Returns: percentile, industry average, top quartile threshold
- [ ] Dashboard integration: "You're in the 65th percentile for CA CPAs"
- [ ] Data refresh: daily cron job recalculates aggregates

---

### NCE-18: Audit-Ready Report Generator (P1 — Engineering)
**Effort:** Large | **Dependencies:** NCE-07, NCE-08, NCE-15

One-click PDF report showing complete compliance posture — designed for SOC 2, FERPA, HIPAA audits.

**Acceptance Criteria:**
- [ ] `POST /api/v1/compliance/report` — generates PDF compliance report
- [ ] Report sections: Executive Summary, Compliance Score, Document Inventory, Gap Analysis, Risk Assessment, Expiring Documents, Cross-Reference Findings, Nessie Intelligence Analysis, Bitcoin Anchor Proofs
- [ ] Every claim in the report links to an anchored source document
- [ ] PDF generation (reuse VAI-03 report infrastructure)
- [ ] Template variants: SOC 2, FERPA, HIPAA, General
- [ ] Shareable link with time-limited access token
- [ ] Audit trail: report generation logged as audit event

---

### NCE-19: Nessie MCP Tools for Agent Frameworks (P2 — Engineering)
**Effort:** Medium | **Dependencies:** NCE-16 (compliance API)

Extend the existing MCP server with Nessie compliance intelligence tools so AI agents (LangChain, AutoGen, Claude) can query compliance status programmatically.

**Acceptance Criteria:**
- [ ] New MCP tools: `nessie_compliance_score`, `nessie_gap_analysis`, `nessie_ask`, `nessie_cross_reference`
- [ ] Tools return structured JSON consumable by agent frameworks
- [ ] Integration with existing `sdks/mcp-server/` infrastructure
- [ ] LangChain tool wrapper in `sdks/langchain-ts/`
- [ ] Tests

---

### NCE-20: Upload to HuggingFace + Model Card (P2 — Ops)
**Effort:** Small | **Dependencies:** NCE-04 (intelligence model trained)

Ship Nessie Intelligence model weights to HuggingFace for portable serving. Extends NMT-05.

**Acceptance Criteria:**
- [ ] Upload Nessie Intelligence v1 to `carsonarkova/nessie-intelligence-v1-llama-3.1-8b`
- [ ] Model card with: capabilities, eval results, training data composition, usage examples
- [ ] Verify model loads on vLLM/RunPod from HF repo
- [ ] Update RunPod endpoint template

---

## Phase 6: Nessie v2 — Self-Improving Intelligence (Months 3-6)

> **Goal:** Nessie gets smarter over time from user interactions and expanding corpus.

### NCE-21: Feedback Loop — Learn from User Actions (P2 — Engineering)
**Effort:** Large | **Dependencies:** NCE-11 (chat), NCE-10 (dashboard)

When users act on Nessie's recommendations (upload a missing document, renew a license), that's positive signal. When they dismiss or ignore, that's negative signal. Feed this back into training.

**Acceptance Criteria:**
- [ ] Track: recommendation shown → user action (uploaded, dismissed, ignored)
- [ ] Export positive/negative pairs for DPO training
- [ ] Monthly retrain cycle: incorporate user feedback into Nessie's preferences
- [ ] Privacy: no PII in training data, only anonymized action patterns

---

### NCE-22: Continuous Corpus Expansion (P2 — Engineering)
**Effort:** Medium | **Dependencies:** NCE-01 (corpus enabled)

Expand the public records corpus from 320K to 1M+ documents, focusing on jurisdiction-specific regulatory sources.

**Acceptance Criteria:**
- [ ] New fetchers: State Bar associations (beyond CalBar), State Board of Accountancy, Nursing Board
- [ ] Target: 10+ state-specific regulatory sources
- [ ] Embedding pipeline handles incremental updates (not full reindex)
- [ ] Corpus stats dashboard in admin panel

---

### NCE-23: Client-Side Nessie (P3 — Research)
**Effort:** XL | **Dependencies:** NCE-04

Quantize Nessie Intelligence to 1B-3B parameters for WebLLM client-side inference. Preserves "documents never leave the device" guarantee while enabling on-device compliance analysis.

**Acceptance Criteria:**
- [ ] Knowledge distillation: 8B → 3B (or 1B) with <5% quality loss on intelligence benchmark
- [ ] GGUF/ONNX export for WebLLM
- [ ] Browser benchmark: >40 tokens/sec on M1 MacBook
- [ ] Privacy guarantee: zero network calls for intelligence queries
- [ ] Research spike first — validate feasibility before committing

---

## Dependency Graph

```
NCE-01 (Enable Corpus) ─────┐
                             ├──→ NCE-03 (Distill Data) ──→ NCE-04 (Fine-Tune) ──→ NCE-05 (Eval)
NCE-02 (Gemini v2 Retrain) ─┘                                     │
                                                                   ├──→ NCE-06 (Jurisdiction Rules) ──→ NCE-07 (Score Calculator) ──→ NCE-08 (Gap Detector)
                                                                   │                                          │                            │
                                                                   │                                          ├──→ NCE-09 (Expiry Alerts)  │
                                                                   │                                          │                            │
                                                                   │                                          ├──→ NCE-10 (Dashboard) ◄────┘
                                                                   │                                          │
                                                                   ├──→ NCE-11 (Chat UI)                     ├──→ NCE-12 (Score Widget)
                                                                   │                                          │
                                                                   ├──→ NCE-13 (DPO Training)                ├──→ NCE-16 (Compliance API)
                                                                   │                                          │
                                                                   ├──→ NCE-14 (Jurisdiction LoRA)            ├──→ NCE-17 (Benchmarking)
                                                                   │                                          │
                                                                   ├──→ NCE-15 (Cross-Reference)              ├──→ NCE-18 (Audit Reports)
                                                                   │                                          │
                                                                   └──→ NCE-20 (HuggingFace Upload)           └──→ NCE-19 (MCP Tools)
```

## Sprint Plan

### Sprint 1 (Weeks 1-2): Foundation
| Story | Priority | Effort | Parallel? |
|-------|----------|--------|-----------|
| NCE-01 | P0 | Small | Yes (with NCE-02) |
| NCE-02 | P0 | Small | Yes (with NCE-01) |
| NCE-03 | P0 | Large | After NCE-01 |

### Sprint 2 (Weeks 2-4): Train + Evaluate
| Story | Priority | Effort | Parallel? |
|-------|----------|--------|-----------|
| NCE-04 | P0 | Medium | After NCE-03 |
| NCE-05 | P0 | Medium | After NCE-04 |
| NCE-06 | P0 | Large | Parallel with NCE-04 |

### Sprint 3 (Weeks 4-6): Scoring Engine
| Story | Priority | Effort | Parallel? |
|-------|----------|--------|-----------|
| NCE-07 | P0 | Large | After NCE-06 |
| NCE-08 | P0 | Medium | After NCE-07 |
| NCE-09 | P1 | Medium | After NCE-07 |

### Sprint 4 (Weeks 5-7): Frontend
| Story | Priority | Effort | Parallel? |
|-------|----------|--------|-----------|
| NCE-10 | P0 | Large | After NCE-07 + NCE-08 |
| NCE-11 | P1 | Large | Parallel with NCE-10 |
| NCE-12 | P1 | Small | After NCE-10 |

### Sprint 5 (Weeks 6-8): Advanced Training
| Story | Priority | Effort | Parallel? |
|-------|----------|--------|-----------|
| NCE-13 | P1 | Large | After NCE-05 |
| NCE-14 | P1 | Large | After NCE-06 + NCE-04 |
| NCE-15 | P1 | Medium | After NCE-04 |

### Sprint 6 (Weeks 8-12): Enterprise
| Story | Priority | Effort | Parallel? |
|-------|----------|--------|-----------|
| NCE-16 | P1 | Medium | After NCE-07 + NCE-08 |
| NCE-17 | P2 | Medium | After NCE-07 (needs adoption) |
| NCE-18 | P1 | Large | After NCE-07 + NCE-08 + NCE-15 |
| NCE-19 | P2 | Medium | After NCE-16 |
| NCE-20 | P2 | Small | After NCE-04 |

### Future (Months 3-6)
| Story | Priority | Effort | Notes |
|-------|----------|--------|-------|
| NCE-21 | P2 | Large | Needs user adoption data |
| NCE-22 | P2 | Medium | Continuous |
| NCE-23 | P3 | XL | Research spike first |

## Cost Estimate

| Item | Estimated Cost |
|------|---------------|
| Gemini embedding (320K records) | ~$50 |
| Gemini Golden v2 training (Vertex AI) | ~$50 |
| Gemini distillation (1,150 queries) | ~$15 |
| Together AI fine-tune (intelligence) | ~$75 |
| Together AI DPO fine-tune | ~$75 |
| RunPod eval + serving | ~$50/month |
| Jurisdiction LoRA training (3 adapters) | ~$150 |
| **Total Phase 1-4** | **~$465** |
| **Monthly serving (RunPod)** | **~$50-100/month** |

## Success Metrics

| Metric | Target | Measured By |
|--------|--------|-------------|
| Intelligence citation accuracy | >95% (>98% post-DPO) | NCE-05 eval benchmark |
| Compliance score adoption | >50% of active orgs check score within 30 days | Analytics |
| Gap analysis → document upload conversion | >20% | Funnel tracking |
| Nessie chat queries/week | >100 within 60 days of launch | API logs |
| Expiry alert → renewal action | >30% | Email click-through |
| Organization tier conversion | 3+ orgs on Organization plan within 90 days | Stripe |
| Time to audit-ready report | <5 minutes (vs hours manually) | User feedback |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Hallucinated citations | Validate all citations against retrieved docs (already in nessie-query.ts) + DPO training |
| Overconfident intelligence | Calibration pipeline (NMT-03 pattern) applied to intelligence responses |
| Training prompt mismatch | Use EXACTLY the intelligence system prompt at inference (0% F1 lesson from v5) |
| Catastrophic forgetting | 25% general instruction data mix |
| Jurisdiction rule accuracy | Human review of initial rules + regulatory source citations |
| Low corpus coverage in specific jurisdictions | Prioritize fetcher development for high-demand states |
| Privacy concerns with benchmarking | Minimum 5 orgs per bucket, no org identifiers, aggregate only |
