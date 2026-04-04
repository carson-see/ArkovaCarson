# Nessie Intelligence Training Plan

> **Date:** 2026-04-03 | **Author:** Session 24
> **Status:** Active | **Priority:** P0
> **Strategy docs:** Arkova-Verified-Intelligence-SLM-Analysis, Arkova Strategic Blueprint, Nessie-Training-Best-Practices

---

## 1. The Problem

Nessie v5 (87.2% F1) was trained as a metadata extraction model — but extraction is **Gemini Golden's job**. Nessie's actual role is a **compliance intelligence engine** that analyzes documents and makes recommendations backed by Bitcoin-anchored evidence.

| Model | Actual Role | Current Training | Gap |
|-------|-------------|-----------------|-----|
| **Gemini Golden** | Metadata extraction, templates, fraud detection | 1,314 extraction examples (phases 1-9) | Missing phases 10-11 (291 examples). Hardcoded confidence. |
| **Nessie** | Compliance intelligence — analysis, recommendations, verified citations | 1,903 extraction examples (wrong task!) | Entire training data is for the wrong job |

## 2. Architecture

```
User uploads document
        │
        ▼
┌──────────────────┐
│  Gemini Golden   │ ← Extraction engine
│  (Vertex AI)     │   Extracts: credentialType, issuerName, dates,
│  90.4% wF1       │   jurisdiction, fraudSignals, confidence
└──────┬───────────┘
       │ structured metadata
       ▼
┌──────────────────┐     ┌──────────────────────┐
│  Bitcoin Anchor  │ ──→ │  Public Records RAG  │
│  (OP_RETURN)     │     │  (pgvector, 320K+    │
└──────────────────┘     │   anchored docs)     │
                         └──────┬───────────────┘
                                │ retrieved context
                                ▼
                    ┌──────────────────────┐
                    │       Nessie         │ ← Intelligence engine
                    │  (Together AI / RP)  │   Analyzes, recommends,
                    │  Target: >85% QA F1  │   cites anchored evidence
                    └──────────────────────┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
              Compliance   Risk        Cross-
              Q&A          Analysis    Reference
```

## 3. What's Built (as of 2026-04-03)

### Infrastructure (READY)
- [x] pgvector tables + HNSW/IVFFlat indexes (migrations 0051, 0060, 0077, 0080)
- [x] Public records embedding pipeline (`publicRecordEmbedder.ts`, batch 500, concurrency 10)
- [x] Nessie query endpoint (`/api/v1/nessie/query`) with retrieval + context modes
- [x] RAG prompt with source authority weighting (EDGAR > Federal Register > CourtListener)
- [x] Verified citation enrichment with anchor proofs (chain_tx_id, explorer_url, verify_url)
- [x] LRU context cache (5 min TTL, 100 entries)
- [x] 13 public record fetchers (EDGAR, OpenAlex, CourtListener, USPTO, etc.)
- [x] 320K+ public records in database

### Training Pipeline (NEW — Session 24)
- [x] Intelligence training data types and formats (`nessie-intelligence-data.ts`)
- [x] 5 intelligence task types defined (compliance_qa, risk_analysis, document_summary, recommendation, cross_reference)
- [x] 5 seed Q&A pairs with verified citations
- [x] Training example converter (ChatML with RAG context, matches inference format)
- [x] Deduplication and validation utilities
- [x] Intelligence system prompts for all 5 modes (`prompts/intelligence.ts`)
- [x] 34 tests passing

### Gemini Golden v2 (READY)
- [x] Finetune script updated with phases 10-11 (1,605 total entries)
- [x] Hardcoded confidence replaced with `computeRealisticConfidence()`

### NOT Built Yet
- [ ] Distilled intelligence training examples (need 500+)
- [ ] Intelligence-specific Nessie fine-tune
- [ ] Intelligence evaluation benchmark
- [ ] Frontend intelligence UI (users can't talk to Nessie yet)
- [ ] `ENABLE_PUBLIC_RECORD_EMBEDDINGS` flag turned ON

## 4. Training Plan — 6 Phases

### Phase A: Enable Corpus (Ops — 1 day)

Turn on the embedding pipeline. Nessie can't reason without documents.

1. Set `ENABLE_PUBLIC_RECORD_EMBEDDINGS = true` in production switchboard
2. Run `embedPublicRecords()` to generate embeddings for 320K+ records
3. Verify: `GET /api/v1/nessie/query?q=SEC+10-K+filing&mode=retrieval` returns results
4. Monitor embedding costs (Gemini embedding API)

**Blocker:** Needs GEMINI_API_KEY with embedding quota for 320K records.

### Phase B: Gemini Golden v2 Submission (Ops — 1 day, parallel with A)

1. Run `npx tsx scripts/gemini-golden-finetune.ts --dry-run` — validate 1,605 entries
2. Submit Vertex AI tuning job (estimated cost: ~$50 for 8 epochs on 1,605 examples)
3. Wait for training (typically 2-6 hours)
4. Evaluate against golden dataset (target: >92% weighted F1)
5. If improved: update `GEMINI_TUNED_MODEL` endpoint in Cloud Run

### Phase C: Distill Intelligence Training Data (Engineering — 1-2 weeks)

This is the core work. Use Gemini as teacher to generate high-quality intelligence responses for training Nessie.

**Method:**
1. Select 200 diverse public records from each domain (SEC, USPTO, CourtListener, Federal Register, OpenAlex)
2. For each record, generate 3-5 intelligence queries across task types
3. Feed queries + record context to Gemini with intelligence system prompt
4. Gemini generates teacher responses (analysis + citations + risks + recommendations)
5. Validate: citations reference actual documents, JSON is valid, confidence is calibrated
6. Target: 1,000-2,000 curated intelligence examples

**Quality gates (per Best Practices doc):**
- Cross-model verification: validate subset with a second model
- Human review: 5-10% manual spot-check by domain expert
- Distribution check: balanced across task types and domains
- Reject any example with hallucinated citations

**Domain distribution target:**

| Domain | Examples | Task Types |
|--------|----------|------------|
| SEC / Financial | 250 | compliance_qa, risk_analysis, document_summary |
| Legal / Court | 200 | compliance_qa, cross_reference, recommendation |
| Regulatory | 200 | compliance_qa, recommendation, document_summary |
| Patent / IP | 150 | cross_reference, risk_analysis, document_summary |
| Academic | 100 | risk_analysis, cross_reference, document_summary |
| General mix (25%) | 250 | All types (prevents catastrophic forgetting) |
| **Total** | **1,150** | |

### Phase D: Fine-Tune Nessie Intelligence (Engineering — 1 week)

1. Export training data as Together AI JSONL (`nessie-intelligence-export.ts`)
2. Training config (per Best Practices doc):
   - Base: Llama 3.1 8B Instruct
   - LoRA rank: 32 (higher for complex compliance reasoning, per doc §3.2)
   - Alpha: 64 (2x rank)
   - LR: 2e-4 with cosine decay
   - Epochs: 2 (per doc §3.6: >3 epochs → overfitting)
   - Batch: 2 × 8 grad accumulation = effective 16
   - bf16 precision
   - 25% general instruction data mix
3. Submit to Together AI
4. Deploy to RunPod for evaluation

**CRITICAL:** Use intelligence system prompt at inference, NOT the extraction condensed prompt. Fine-tuned models MUST use the same prompt they were trained with (Best Practices §7.2 — mismatch causes 0% F1).

### Phase E: Evaluate Intelligence Model (Engineering — 3-5 days)

Build a compliance intelligence evaluation benchmark (separate from extraction F1):

**Metrics (per strategy doc §5.1):**

| Metric | Target | Description |
|--------|--------|-------------|
| Citation accuracy | >95% | Do citations reference actual documents? |
| Faithfulness | >0.90 | Are claims supported by retrieved context? |
| Answer relevance | >0.85 | Does the answer address the query? |
| Risk detection recall | >80% | Does it find known risks in test cases? |
| Recommendation quality | Manual | Expert review of recommendation usefulness |
| Confidence correlation | r > 0.60 | Does confidence predict answer quality? |
| Latency P95 | <5s | Time to generate intelligence response |

**Test set:** 100 expert-annotated Q&A pairs across domains (20 per domain).

### Phase F: Frontend Intelligence UI (Engineering — 1-2 weeks)

Build the user-facing interface for Nessie intelligence queries.

**Components needed:**
1. Intelligence query input (text field + mode selector)
2. Response display with inline citations
3. Citation cards with anchor proofs (tx hash, explorer link, verify link)
4. Risk/recommendation cards
5. Confidence indicator

**API:** Already exists at `/api/v1/nessie/query?mode=context` — just needs frontend.

## 5. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Hallucinated citations | Validate all citations against retrieved docs (already implemented in nessie-query.ts) |
| Overconfident intelligence | Calibration pipeline (NMT-03 pattern) applied to intelligence responses |
| Training prompt mismatch | Use EXACTLY the intelligence system prompt at inference (learned from v5 extraction) |
| Catastrophic forgetting | 25% general instruction data mix in training |
| Low corpus coverage | 320K+ records across 13 sources already in DB — enable embeddings |

## 6. Success Criteria

| Milestone | Criteria | Timeline |
|-----------|----------|----------|
| Corpus enabled | >50K records with embeddings, query endpoint returns results | Phase A (1 day) |
| Gemini Golden v2 | >92% weighted F1 on full golden dataset | Phase B (1 day) |
| Training data ready | >1,000 validated intelligence examples across 5 task types | Phase C (1-2 weeks) |
| Nessie Intelligence v1 | Citation accuracy >95%, faithfulness >0.90 | Phase D+E (2 weeks) |
| User-facing intelligence | Frontend query UI live, 50+ beta user queries/week | Phase F (1-2 weeks) |

## 7. Cost Estimate

| Item | Estimated Cost |
|------|---------------|
| Gemini embedding (320K records) | ~$50 (Gemini embedding API) |
| Gemini Golden v2 training | ~$50 (Vertex AI, 8 epochs, 1,605 examples) |
| Gemini distillation (1,000 queries) | ~$10 (Gemini 2.5 Flash API) |
| Together AI fine-tune (Nessie intelligence) | ~$50 (LoRA, 1,150 examples, 2 epochs) |
| RunPod eval (A6000 48GB, ~2 hours) | ~$1 |
| **Total** | **~$160** |

## 8. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-03 | Pivot Nessie from extraction to intelligence | Nessie's strategic role is compliance intelligence, not extraction. Extraction is Gemini Golden's job. |
| 2026-04-03 | Use LoRA rank 32 (up from 16) for intelligence | Strategy doc §3.2: higher rank for complex domain tasks. Compliance reasoning is more complex than extraction. |
| 2026-04-03 | Distill from Gemini teacher, not self-generate | Strategy doc §1.6: step-by-step distillation outperforms standard methods. Gemini is the best available teacher. |
| 2026-04-03 | Keep v5 extraction model on RunPod as fallback | v5 still useful as extraction fallback if Gemini is down. Don't destroy — keep serving on existing endpoint. |
