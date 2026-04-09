# Story Group 28: Gemini Migration & Evolution — 2.5 Flash Sunset to Gemini 3

> **Created:** 2026-04-09 | **Epic:** Gemini Migration & Evolution (GME)
> **Jira Epic:** SCRUM-612 | **Stories:** SCRUM-613–628 | **Priority:** P0 — CRITICAL (deadline-driven)
> **Deadline:** June 17, 2026 (69 days) — `gemini-2.5-flash` shutdown
> **Depends on:** Existing Gemini infrastructure (gemini.ts, golden finetune, embedding pipeline)
> **Reference:** [Google Gemini Deprecations](https://ai.google.dev/gemini-api/docs/deprecations)

---

## The Problem

**`gemini-2.5-flash` shuts down June 17, 2026.** Every Gemini call in Arkova breaks that day.

| Model | Shutdown Date | Days Left | Used For |
|-------|-------------|-----------|----------|
| `gemini-2.0-flash` | June 1, 2026 | **53 days** | Nessie distillation scripts |
| `gemini-2.5-flash` | **June 17, 2026** | **69 days** | Production extraction, fraud detection, embeddings fallback, training base |
| `gemini-2.5-pro` | June 17, 2026 | 69 days | Not currently used |

### What Breaks

1. **All metadata extraction** — every document upload calls Gemini
2. **Fraud detection** — visual document analysis (multimodal)
3. **Public record embedding** — 320K+ records use Gemini embedding API
4. **Gemini Golden tuned model** — trained on 2.5 Flash base, endpoint may stop working
5. **All training/eval scripts** — hardcoded model references
6. **Nessie intelligence distillation** — Gemini is the teacher model
7. **Tag generation** — lightweight classification

### Replacement Models Available

| Current | Replacement | Status | Fine-Tune Support |
|---------|-------------|--------|-------------------|
| `gemini-2.5-flash` | `gemini-3-flash-preview` | Preview (no GA yet) | **NOT CONFIRMED** |
| `gemini-2.0-flash` | `gemini-3-flash-preview` | Preview | NOT CONFIRMED |
| `gemini-embedding-001` | `gemini-embedding-2-preview` | Preview (multimodal) | N/A |

**Critical risk:** Gemini 3 Flash fine-tuning is NOT yet documented. If fine-tuning isn't available by June, the Gemini Golden tuned model cannot be migrated — we fall back to base model (90.4% → ~82% F1 regression).

---

## Current Gemini Surface Area (35+ files)

### Core Provider
- `services/worker/src/ai/gemini.ts` — Main provider: extraction, embeddings, ensemble, circuit breaker
- `services/worker/src/ai/gemini.test.ts` — 30+ tests
- `services/worker/src/ai/factory.ts` — Provider factory (routes to gemini/nessie/mock)

### Hardcoded Model References

| File | Line | Current Value | Needs Update |
|------|------|---------------|-------------|
| `gemini.ts` | ~41 | `gemini-2.5-flash` | YES |
| `gemini.ts` | ~42 | `gemini-embedding-001` | YES |
| `gemini.ts` | ~78 | Vertex AI endpoint (tuned) | RETRAIN needed |
| `gemini-golden-finetune.ts` | 286 | `gemini-2.5-flash` base | YES |
| `gemini-train-pipeline.ts` | 55 | `gemini-2.5-flash` | YES |
| `nessie-v4-pipeline.ts` | 316-317 | `gemini-2.0-flash` | YES |
| `nessie-multi-lora-pipeline.ts` | 410 | `gemini-2.5-flash` | YES |
| `nessie-intelligence-distill.ts` | 132 | `gemini-2.5-flash` | YES |
| `nessie-reasoning-pipeline.ts` | 232 | `gemini-2.5-flash` | YES |
| `eval-intelligence.ts` | 221 | `gemini-2.5-flash` | YES |
| `nessie-query.ts` | 482 | `gemini-2.5-flash` | YES |
| `ai-fraud-visual.test.ts` | 122+ | `gemini-2.5-flash` | YES |
| `.env.example` | 70 | `gemini-2.5-flash` | YES |
| `CLAUDE.md` | 480 | `gemini-2.5-flash` | YES |

### Capabilities Used

| Capability | Where | Model |
|-----------|-------|-------|
| Text generation (JSON) | Extraction, tags, templates | `gemini-2.5-flash` / tuned |
| Multimodal vision | Fraud detection | `gemini-2.5-flash` |
| Embeddings | Public records, search | `gemini-embedding-001` |
| Vertex AI fine-tuning | Golden model training | `gemini-2.5-flash` base |
| Structured output | All extraction | `responseMimeType: 'application/json'` |

### Environment Variables

| Var | Default | Used By |
|-----|---------|---------|
| `GEMINI_API_KEY` | (required) | All Gemini calls |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Extraction, generation |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | Vector embeddings |
| `GEMINI_TUNED_MODEL` | (optional endpoint) | Production tuned model |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Vertex AI training |

---

## Phase 1: Emergency Migration (Weeks 1-2) — DEADLINE DRIVEN

> **Goal:** Nothing breaks on June 17. Swap model references, validate, deploy.

### GME-01: Model Reference Audit & Centralization (P0)
**Effort:** Small (1 day) | **Dependencies:** None

Centralize all Gemini model references into a single config so migration is a one-line change, not a 14-file hunt.

**Acceptance Criteria:**
- [ ] New `services/worker/src/ai/gemini-config.ts` — single source of truth for all model IDs
- [ ] Constants: `GEMINI_GENERATION_MODEL`, `GEMINI_EMBEDDING_MODEL`, `GEMINI_VISION_MODEL`
- [ ] All 14+ files updated to import from config instead of hardcoding
- [ ] Env var overrides still work (`GEMINI_MODEL` etc.)
- [ ] Tests pass with no behavior change
- [ ] Zero hardcoded `gemini-2.5-flash` or `gemini-2.0-flash` strings anywhere

---

### GME-02: Migrate to Gemini 3 Flash (P0 — CRITICAL)
**Effort:** Medium (3-5 days) | **Dependencies:** GME-01

Swap `gemini-2.5-flash` → `gemini-3-flash-preview` (or GA equivalent when available) across production.

**Acceptance Criteria:**
- [ ] Update `GEMINI_GENERATION_MODEL` default to `gemini-3-flash-preview`
- [ ] Verify structured JSON output (`responseMimeType: 'application/json'`) works on Gemini 3
- [ ] Verify multimodal vision (fraud detection) works on Gemini 3
- [ ] Run extraction eval against golden dataset: target within 2pp of current 90.4% (tuned) / 82.1% (base)
- [ ] Run fraud detection eval: no regression on known test cases
- [ ] Test circuit breaker, retry logic, error handling with new model
- [ ] Update `.env.example`, `CLAUDE.md`, all documentation
- [ ] Deploy to Cloud Run staging first, then production
- [ ] Monitor error rates for 48 hours post-deploy

**Risk:** If Gemini 3 Flash has different JSON output behavior, extraction parsing may break. Test thoroughly.

---

### GME-03: Migrate Embedding Model (P0)
**Effort:** Small (1-2 days) | **Dependencies:** None (parallel with GME-02)

Evaluate `gemini-embedding-2-preview` vs current `gemini-embedding-001`. The new model is multimodal — may improve search quality.

**Acceptance Criteria:**
- [ ] Benchmark embedding quality: run hybrid search eval on 100 queries, compare NDCG
- [ ] If `gemini-embedding-001` is NOT being deprecated: keep it (stability > novelty)
- [ ] If deprecated: migrate to `gemini-embedding-2-preview`
- [ ] Verify vector dimensions match (768d) — if different, need pgvector index rebuild
- [ ] Test public record embedding pipeline end-to-end
- [ ] Update config + env vars

**Risk:** If embedding dimensions change, ALL 320K+ records need re-embedding (~$50 + downtime).

---

### GME-04: Gemini Golden Tuned Model Migration (P0 — CRITICAL)
**Effort:** Large (1-2 weeks) | **Dependencies:** GME-02

The Gemini Golden tuned model (90.4% F1) was trained on `gemini-2.5-flash`. When the base model is deprecated, the tuned endpoint may stop working. Need to retrain on Gemini 3 base.

**Acceptance Criteria:**
- [ ] Check if existing Vertex AI tuned endpoint survives base model deprecation (ask Google support / test)
- [ ] If endpoint survives: document and monitor, defer retraining
- [ ] If endpoint dies: retrain Gemini Golden on `gemini-3-flash-preview` base
  - [ ] Validate fine-tuning API supports Gemini 3 Flash
  - [ ] Submit Vertex AI tuning job with full 1,605-entry dataset
  - [ ] Evaluate: target >90% weighted F1 (match or beat v1)
  - [ ] Update `GEMINI_TUNED_MODEL` endpoint in Cloud Run
- [ ] If fine-tuning NOT available for Gemini 3: implement few-shot prompting fallback (use golden dataset examples in prompt)
- [ ] Document migration path and new endpoint

**Fallback plan:** If Gemini 3 can't be fine-tuned yet, use base Gemini 3 Flash with enhanced few-shot prompting from golden dataset (~82% F1 baseline, improved with examples).

---

### GME-05: Deprecation Monitoring & Alerts (P1)
**Effort:** Small (half day) | **Dependencies:** None

Set up monitoring so we're never surprised by another deprecation.

**Acceptance Criteria:**
- [ ] Worker health check includes Gemini model availability test
- [ ] Alert (Sentry + email) if Gemini returns deprecation warnings in response headers
- [ ] Calendar reminder: 30 days before any Google API deprecation deadline
- [ ] Document in ops runbook: "Gemini model migration procedure"

---

## Phase 2: Eval & Quality Assurance (Weeks 2-4)

> **Goal:** Prove Gemini 3 extraction quality matches or beats 2.5 Flash across all credential types.

### GME-06: Full Golden Dataset Eval on Gemini 3 (P0)
**Effort:** Medium (3-5 days) | **Dependencies:** GME-02

Run the complete 1,605-entry golden dataset eval against Gemini 3 Flash (base and tuned if available).

**Acceptance Criteria:**
- [ ] Eval against full golden dataset (all 12 phases)
- [ ] Per-credential-type F1 breakdown (all 21 types)
- [ ] Compare: Gemini 2.5 Flash base vs Gemini 3 Flash base
- [ ] Compare: Gemini Golden v1 (2.5 tuned) vs Gemini 3 base vs Gemini 3 tuned (if available)
- [ ] Identify any credential types with >5pp regression
- [ ] For regressions: add targeted few-shot examples or prompt adjustments
- [ ] Results documented in `docs/eval/`
- [ ] Confidence calibration verified (ECE < 15%)

**Metrics to track:**

| Metric | Gemini 2.5 (baseline) | Gemini 3 Target |
|--------|----------------------|-----------------|
| Weighted F1 | 82.1% (base) / 90.4% (tuned) | >82% (base) / >90% (tuned) |
| Macro F1 | 82.1% / 81.4% | >80% |
| ECE | ~10% / 9.5% | <12% |
| Latency P50 | ~3s / 5.4s | <5s |

---

### GME-07: Fraud Detection Eval on Gemini 3 (P1)
**Effort:** Small (1-2 days) | **Dependencies:** GME-02

Validate multimodal fraud detection quality on Gemini 3.

**Acceptance Criteria:**
- [ ] Run fraud detection on 50+ known test images (mix of clean + tampered)
- [ ] Compare risk level accuracy: Gemini 2.5 vs 3
- [ ] Verify base64 image input handling (png, jpeg, webp, gif)
- [ ] No regression in fraud signal detection (font inconsistency, metadata tampering, etc.)
- [ ] Results documented

---

### GME-08: Embedding Quality Benchmark (P1)
**Effort:** Small (1-2 days) | **Dependencies:** GME-03

If migrating embeddings, verify search quality doesn't regress.

**Acceptance Criteria:**
- [ ] 100-query benchmark: compare retrieval NDCG between old and new embedding model
- [ ] Test hybrid search (BM25 + dense) with new embeddings
- [ ] Verify Nessie intelligence RAG quality not degraded
- [ ] If NDCG drops >5%: keep old model or investigate
- [ ] Document results

---

## Phase 3: Training Infrastructure Update (Weeks 3-5)

> **Goal:** All training pipelines work with Gemini 3. Golden dataset retrained.

### GME-09: Update All Training Scripts (P1)
**Effort:** Medium (2-3 days) | **Dependencies:** GME-01 (centralized config)

Update every training and eval script to use Gemini 3 model references.

**Acceptance Criteria:**
- [ ] `gemini-golden-finetune.ts` — base model → Gemini 3
- [ ] `gemini-train-pipeline.ts` — base model → Gemini 3
- [ ] `nessie-v4-pipeline.ts` — distillation model → Gemini 3
- [ ] `nessie-multi-lora-pipeline.ts` — teacher model → Gemini 3
- [ ] `nessie-intelligence-distill.ts` — teacher model → Gemini 3
- [ ] `nessie-reasoning-pipeline.ts` — teacher model → Gemini 3
- [ ] `eval-intelligence.ts` — eval model → Gemini 3
- [ ] `eval-gemini-golden-v2-full.ts` — eval model → Gemini 3
- [ ] All scripts compile and `--dry-run` succeeds
- [ ] Tests updated (hardcoded model names in test assertions)

---

### GME-10: Gemini Golden v2 on Gemini 3 Base (P0)
**Effort:** Large (1 week) | **Dependencies:** GME-04, GME-09
**Blocked by:** Vertex AI fine-tuning support for Gemini 3

Retrain Gemini Golden on Gemini 3 base with the full 1,605-entry dataset + realistic confidence scoring.

**Acceptance Criteria:**
- [ ] Confirm Vertex AI supports fine-tuning `gemini-3-flash-preview` (or GA model)
- [ ] Submit tuning job: 1,605 examples, 8 epochs, computed confidence
- [ ] Evaluate: target >90% weighted F1, >80% macro F1
- [ ] Per-type F1 analysis — verify SEC_FILING, DEGREE, LICENSE maintain >90%
- [ ] Update `GEMINI_TUNED_MODEL` in Cloud Run
- [ ] Old tuned endpoint kept as fallback until verified
- [ ] Results in `docs/eval/`

---

### GME-11: Gemini Golden v3 — Expanded Training Data (P1)
**Effort:** Large (1-2 weeks) | **Dependencies:** GME-10

Expand the golden dataset beyond 1,605 entries and retrain for higher accuracy.

**Acceptance Criteria:**
- [ ] Add 400+ new golden entries targeting weak types (from eval results)
- [ ] Include multimodal examples (document images with text) if Gemini 3 supports vision fine-tuning
- [ ] New training data phases 13-14
- [ ] Target: >93% weighted F1 on expanded golden dataset
- [ ] Improved confidence calibration (ECE < 8%)
- [ ] Document per-phase contribution to accuracy

---

## Phase 4: Advanced Gemini 3 Capabilities (Weeks 5-8)

> **Goal:** Leverage Gemini 3's new capabilities that weren't available in 2.5.

### GME-12: Multimodal Embedding for Document Images (P2)
**Effort:** Medium | **Dependencies:** GME-03

`gemini-embedding-2-preview` supports image, video, audio, and PDF embeddings. Use this to embed document images directly — enabling visual similarity search.

**Acceptance Criteria:**
- [ ] Embed document screenshots/images alongside text metadata
- [ ] Visual similarity search: "find documents that look like this"
- [ ] Store image embeddings in pgvector (same infrastructure)
- [ ] Test: upload a degree → find visually similar degrees in corpus
- [ ] Switchboard flag: `ENABLE_MULTIMODAL_EMBEDDINGS` (default: false)

---

### GME-13: Enhanced Fraud Detection with Gemini 3 Vision (P1)
**Effort:** Medium | **Dependencies:** GME-02, GME-07

Gemini 3 has improved multimodal reasoning. Leverage for better fraud detection.

**Acceptance Criteria:**
- [ ] Benchmark Gemini 3 vs 2.5 on fraud test suite
- [ ] If improved: update fraud prompt to leverage new capabilities
- [ ] Add new fraud signals if Gemini 3 can detect: watermark manipulation, resolution inconsistency, metadata stripping
- [ ] Update fraud vision prompt (`prompts/fraud-vision.ts`)
- [ ] Document improvements

---

### GME-14: Structured Output Schema Validation (P1)
**Effort:** Small | **Dependencies:** GME-02

Gemini 3 may have improved structured output. Validate and tighten extraction schemas.

**Acceptance Criteria:**
- [ ] Test if Gemini 3 supports JSON Schema enforcement (not just `responseMimeType`)
- [ ] If supported: add Zod-derived JSON schemas to extraction calls for guaranteed field types
- [ ] Reduce JSON parse failures (currently handled by `stripJsonComments`)
- [ ] Measure: parse failure rate before vs after

---

### GME-15: Gemini 3 Context Window Optimization (P2)
**Effort:** Medium | **Dependencies:** GME-02

Gemini 3 models likely have larger context windows. Optimize prompts and RAG context.

**Acceptance Criteria:**
- [ ] Document Gemini 3 Flash context window size
- [ ] If larger: expand few-shot examples in extraction prompt (currently ~58K tokens)
- [ ] If larger: increase RAG context for Nessie intelligence queries (currently limited)
- [ ] Benchmark: does more context improve extraction accuracy?
- [ ] Update prompts if beneficial

---

## Phase 5: Cost & Performance Optimization (Weeks 6-10)

> **Goal:** Gemini 3 should be faster and cheaper. Prove it.

### GME-16: Latency & Cost Benchmarking (P1)
**Effort:** Small (1-2 days) | **Dependencies:** GME-02

Benchmark Gemini 3 vs 2.5 on latency, throughput, and cost.

**Acceptance Criteria:**
- [ ] 100-request latency benchmark: P50, P95, P99
- [ ] Token-per-second throughput comparison
- [ ] Cost per extraction comparison (input + output tokens)
- [ ] Cost per embedding comparison
- [ ] Document results, update cost estimates in CLAUDE.md

---

### GME-17: Batch Processing Optimization (P2)
**Effort:** Medium | **Dependencies:** GME-02

If Gemini 3 supports batch API (multiple requests in one call), use it for bulk operations.

**Acceptance Criteria:**
- [ ] Check if Gemini 3 has batch/multi-request API
- [ ] If available: implement batch extraction for XLSX uploads
- [ ] If available: implement batch embedding for public records
- [ ] Measure: batch vs sequential latency and cost savings
- [ ] Update `AI_BATCH_CONCURRENCY` recommendations

---

### GME-18: Gemini 3.1 Flash Lite for Lightweight Tasks (P2)
**Effort:** Small | **Dependencies:** GME-01

Use the cheaper/faster `gemini-3.1-flash-lite-preview` for lightweight tasks (tag generation, template classification) while keeping Flash for extraction.

**Acceptance Criteria:**
- [ ] Add `GEMINI_LITE_MODEL` config option
- [ ] Route `generateTags()` to lite model
- [ ] Route template classification to lite model
- [ ] Benchmark: quality acceptable for lightweight tasks?
- [ ] Measure cost savings

---

## Phase 6: Future-Proofing (Ongoing)

### GME-19: Multi-Model Fallback Chain (P2)
**Effort:** Medium | **Dependencies:** GME-01

Build a proper model fallback chain so no single model deprecation is catastrophic.

**Acceptance Criteria:**
- [ ] Fallback chain: Gemini 3 Tuned → Gemini 3 Base → Nessie v5 → error
- [ ] Automatic failover when primary model returns deprecation/unavailable errors
- [ ] Circuit breaker per model (already exists, extend to chain)
- [ ] Metrics: which model served each request
- [ ] Alert when fallback is triggered

---

### GME-20: Gemini Model Version Pinning (P1)
**Effort:** Small | **Dependencies:** GME-01

Pin to specific model versions (not aliases) to prevent silent quality changes.

**Acceptance Criteria:**
- [ ] Use dated/versioned model IDs where available (e.g., `gemini-3-flash-001` not just `gemini-3-flash-preview`)
- [ ] Document exact model version in extraction manifests (already tracked via `model_version`)
- [ ] Test: verify extraction manifest records correct model version string
- [ ] Ops runbook: "How to upgrade Gemini model version"

---

## Dependency Graph

```
GME-01 (Centralize Config) ──┬──→ GME-02 (Migrate to Gemini 3) ──→ GME-06 (Full Eval)
                             │                                       │
                             ├──→ GME-03 (Migrate Embeddings) ──→ GME-08 (Embed Eval)
                             │                                       │
                             ├──→ GME-05 (Deprecation Alerts)        │
                             │                                       ▼
                             └──→ GME-09 (Update Scripts) ──→ GME-10 (Golden v2 Retrain)
                                                                     │
GME-04 (Tuned Model Migration) ─────────────────────────────────────┘
                                                                     │
GME-02 ──→ GME-07 (Fraud Eval) ──→ GME-13 (Enhanced Fraud)         │
                                                                     ▼
                                                              GME-11 (Golden v3)
                                                                     │
GME-02 ──→ GME-14 (Schema Validation)                               │
GME-02 ──→ GME-15 (Context Window)                                  │
GME-02 ──→ GME-16 (Latency Benchmark) ──→ GME-17 (Batch)           │
GME-01 ──→ GME-18 (Flash Lite)                                      │
GME-01 ──→ GME-19 (Fallback Chain)                                  │
GME-01 ──→ GME-20 (Version Pinning)                                 │
GME-03 ──→ GME-12 (Multimodal Embed)                               │
```

## Sprint Plan

### Sprint 1 (Weeks 1-2): EMERGENCY — Ship Before June 17
| Story | Priority | Effort | Deadline |
|-------|----------|--------|----------|
| GME-01 | P0 | Small | Week 1 |
| GME-02 | P0 | Medium | Week 2 |
| GME-03 | P0 | Small | Week 1 (parallel) |
| GME-04 | P0 | Large | Week 2 (start, may extend) |
| GME-05 | P1 | Small | Week 1 |

### Sprint 2 (Weeks 2-4): Validate Quality
| Story | Priority | Effort |
|-------|----------|--------|
| GME-06 | P0 | Medium |
| GME-07 | P1 | Small |
| GME-08 | P1 | Small |
| GME-09 | P1 | Medium |

### Sprint 3 (Weeks 3-5): Retrain
| Story | Priority | Effort |
|-------|----------|--------|
| GME-10 | P0 | Large |
| GME-11 | P1 | Large |

### Sprint 4 (Weeks 5-8): Optimize
| Story | Priority | Effort |
|-------|----------|--------|
| GME-12 | P2 | Medium |
| GME-13 | P1 | Medium |
| GME-14 | P1 | Small |
| GME-15 | P2 | Medium |

### Sprint 5 (Weeks 6-10): Future-Proof
| Story | Priority | Effort |
|-------|----------|--------|
| GME-16 | P1 | Small |
| GME-17 | P2 | Medium |
| GME-18 | P2 | Small |
| GME-19 | P2 | Medium |
| GME-20 | P1 | Small |

## Cost Estimate

| Item | Estimated Cost |
|------|---------------|
| Gemini 3 eval runs (1,605 entries x 3 runs) | ~$15 |
| Gemini Golden v2 retrain on Gemini 3 (Vertex AI) | ~$50 |
| Gemini Golden v3 retrain (expanded dataset) | ~$75 |
| Re-embedding 320K records (if needed) | ~$50 |
| Fraud detection eval | ~$5 |
| **Total** | **~$195** |

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Gemini 3 fine-tuning not available by June | HIGH | CRITICAL | Few-shot prompting fallback (NCE-04), Nessie v5 as backup |
| Gemini 3 JSON output format differs | MEDIUM | HIGH | Test early (GME-02), fix parsing |
| Embedding dimension change breaks pgvector | LOW | HIGH | Check dimensions before migrating, rebuild indexes if needed |
| Gemini 3 quality regression on specific types | MEDIUM | MEDIUM | Per-type eval (GME-06), targeted few-shot examples |
| Preview model → GA model breaks compatibility | MEDIUM | MEDIUM | Version pinning (GME-20), monitor changelog |
| Vertex AI tuned endpoint dies with base model | UNKNOWN | CRITICAL | Test immediately (GME-04), retrain if needed |
