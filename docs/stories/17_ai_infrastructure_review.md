# AI Infrastructure Review — Requirements & Gap Analysis

> **Author:** ML Engineer Audit (Session 12, 2026-03-23)
> **Status:** REQUIREMENTS — Awaiting prioritization
> **Scope:** All AI subsystems — extraction, search, fraud detection, Nessie, provider abstraction, prompt engineering

---

## Executive Summary

Arkova's AI infrastructure is **functional but unvalidated**. The system extracts credential metadata, generates embeddings, scores integrity, and detects fraud signals. However, there is **no measurement of accuracy, no eval framework, and no production quality monitoring**. Self-reported confidence scores from Gemini are treated as ground truth without calibration. The fraud detection pipeline has no validated false positive rate. Semantic search has a hardcoded similarity threshold with no relevance measurement.

**Risk:** Users trust AI-assigned labels and integrity scores that have never been validated against real-world accuracy benchmarks.

---

## Critical Findings

### CF-1: Confidence Miscalibration (CRITICAL)
- Gemini returns self-reported confidence (0.0-1.0) that is passed directly to users and integrity scoring
- No validation that reported confidence correlates with actual correctness
- Integrity scoring uses raw AI confidence as 1 of 5 components — inflating scores
- **Impact:** System may display "High confidence" on hallucinated fields
- **Fix:** Build golden eval dataset (200+ labeled credentials), measure F1 per field, calibrate via logistic regression

### CF-2: No Accuracy Measurement (CRITICAL)
- Zero ground truth datasets for any AI subsystem
- Extraction accuracy unknown (no F1 scores per field or credential type)
- Search relevance unknown (no precision@k, recall measurement)
- Fraud detection precision/recall unknown
- **Impact:** Cannot set SLOs, cannot detect drift, cannot compare providers
- **Fix:** Create Nessie golden eval set (50 queries), extraction eval set (200 credentials), fraud eval set (100 flagged items)

### CF-3: No Production Quality Monitoring (CRITICAL)
- `extraction_feedback` table stores accept/reject/edit events but no aggregation or alerting
- No dashboard showing accuracy trends, provider latency, cost per extraction
- Circuit breaker trips invisible (no metric, no alert)
- **Impact:** Quality degradation goes undetected
- **Fix:** Build AI metrics dashboard with real-time and weekly rollups

### CF-4: Institution Ground Truth Unvalidated (HIGH)
- `institution_ground_truth` table used for issuer verification scoring
- No documented data source, no update frequency, no accuracy audit
- Missing institutions = false fraud flags; typos = false negatives
- **Fix:** Validate against IPEDS/DAPIP, document sources, add versioning

### CF-5: Duplicate Detection is Fingerprint-Only (HIGH)
- SHA-256 fingerprint match only — different scans of same credential = different hash
- No content-based or embedding-based deduplication
- **Fix:** Add embedding cosine similarity check (threshold 0.95)

### CF-6: Provider Fallback Untested (HIGH)
- Cloudflare fallback uses regex heuristics (confidence hardcoded to 0.4)
- No test coverage for Gemini → fallback switch
- Quality drop during fallback is unmeasured
- **Fix:** Test provider switching, measure heuristic accuracy, add degradation alerts

---

## Subsystem Analysis

### 1. Data Extraction & Recognition

**Current State:**
- Client: PDF.js + Tesseract.js OCR → PII strip → server API
- Server: Gemini 2.0 Flash (temp 0.1, JSON mode, 3 retries, circuit breaker)
- Fields: credentialType, issuerName, issuedDate, expiryDate, fieldOfStudy, degreeLevel, licenseNumber, accreditingBody, jurisdiction, recipientIdentifier
- CLE-specific: creditHours, creditType, barNumber, activityNumber, providerName, approvedBy

**Gaps:**
| Gap | Severity | Story |
|-----|----------|-------|
| No per-field confidence — single score for entire extraction | HIGH | AI-EXT-01 |
| OCR has no preprocessing (deskew, binarization) for scanned docs | MEDIUM | AI-EXT-02 |
| PII stripping misses intl phone formats, credit cards, passport numbers | MEDIUM | AI-EXT-03 |
| No field normalization (jurisdiction "CA" vs "California" vs "Kern County, CA") | MEDIUM | AI-EXT-04 |
| Prompt injection not fully mitigated in edge worker | MEDIUM | AI-EXT-05 |
| 30s timeout with no partial results on large documents | LOW | AI-EXT-06 |

### 2. Semantic Search

**Current State:**
- Model: text-embedding-004 (768-dim, Gemini REST API)
- Storage: pgvector, cosine similarity
- Threshold: 0.7 (hardcoded)
- Batch: 500 records/run, 10 concurrent, every 10 min

**Gaps:**
| Gap | Severity | Story |
|-----|----------|-------|
| Embedding text is naive concatenation — no field weighting | HIGH | AI-SRCH-01 |
| Similarity threshold hardcoded, no per-type tuning | HIGH | AI-SRCH-02 |
| No search relevance metrics (precision@k, recall, click-through) | HIGH | AI-SRCH-03 |
| No embedding drift detection across model versions | MEDIUM | AI-SRCH-04 |
| Cold start: new credentials unfindable for ~10 min | MEDIUM | AI-SRCH-05 |
| No re-ranking by metadata match signals | LOW | AI-SRCH-06 |

### 3. Fraud Detection

**Current State:**
- 5-component integrity score (metadata completeness, extraction confidence, issuer verification, duplicate check, temporal consistency)
- 6 fraud signals detected during extraction
- Weighted average → level (HIGH/MEDIUM/LOW/FLAGGED)
- Review queue for admin

**Gaps:**
| Gap | Severity | Story |
|-----|----------|-------|
| No false positive/negative tracking or measurement | CRITICAL | AI-FRAUD-01 |
| Confidence component uses miscalibrated AI self-report | HIGH | AI-FRAUD-02 |
| No issuer-credential type mismatch detection | MEDIUM | AI-FRAUD-03 |
| No accreditation status check (SACSCOC, HLC, etc.) | MEDIUM | AI-FRAUD-04 |
| Temporal heuristics too rigid (50-year cutoff, no context) | LOW | AI-FRAUD-05 |

### 4. Nessie RAG

**Current State:** NOT IMPLEMENTED (semantic search exists but no retrieval-augmented generation pipeline)

**Required for Phase 2:**
| Requirement | Priority | Story |
|-------------|----------|-------|
| RAG pipeline: query → retrieve → generate response | HIGH | AI-RAG-01 |
| Golden eval set: 50 credential queries with expected answers | HIGH | AI-RAG-02 |
| Citation/attribution for retrieved context | MEDIUM | AI-RAG-03 |
| Hallucination detection in generated responses | MEDIUM | AI-RAG-04 |

### 5. Prompt Engineering

**Current State:**
- Single extraction prompt (111 lines, 11 few-shot examples)
- Temperature 0.1, JSON mode
- Confidence calibration guidance in prompt (not enforced)
- No versioning, no A/B testing

**Gaps:**
| Gap | Severity | Story |
|-----|----------|-------|
| No prompt versioning — impossible to track which prompt produced which result | HIGH | AI-PROMPT-01 |
| Few-shot examples only cover "clean" documents (11 examples) | HIGH | AI-PROMPT-02 |
| No automated prompt eval (does model follow calibration rules?) | HIGH | AI-PROMPT-03 |
| Field definitions ambiguous (recipientIdentifier meaning unclear) | MEDIUM | AI-PROMPT-04 |
| No adversarial examples in few-shot (prompt injection attempts) | MEDIUM | AI-PROMPT-05 |

### 6. Observability & Monitoring

**Current State:**
- Structured logging (Winston/pino)
- ai_usage_events table (extraction events)
- extraction_feedback table (accept/reject/edit)
- Sentry (partial, PII-scrubbed)

**Gaps:**
| Gap | Severity | Story |
|-----|----------|-------|
| No accuracy dashboard (acceptance rate by field/type) | CRITICAL | AI-OBS-01 |
| No provider health monitoring (latency, error rate, circuit breaker) | HIGH | AI-OBS-02 |
| No cost tracking (tokens/extraction, spend over time) | HIGH | AI-OBS-03 |
| No embedding quality metrics (search precision/recall) | MEDIUM | AI-OBS-04 |
| No anomaly alerting (confidence drop, cost spike, latency spike) | MEDIUM | AI-OBS-05 |

---

## Proposed Stories (Priority Order)

### P0 — Must Fix Before Beta Users Rely on AI

| Story | Title | Effort | Dependencies |
|-------|-------|--------|-------------|
| AI-EVAL-01 | Build extraction accuracy eval framework (golden dataset) | Large | None |
| AI-EVAL-02 | Validate confidence calibration against eval set | Medium | AI-EVAL-01 |
| AI-OBS-01 | Build AI metrics dashboard (acceptance rates, latency, cost) | Large | None |
| AI-FRAUD-01 | Audit flagged credentials for false positive rate | Medium | None |

### P1 — High Impact Quality Improvements

| Story | Title | Effort | Dependencies |
|-------|-------|--------|-------------|
| AI-PROMPT-01 | Add prompt versioning (store version with each extraction event) | Small | None |
| AI-PROMPT-02 | Expand few-shot examples to 25+ (including edge cases) | Medium | AI-EVAL-01 |
| AI-PROMPT-03 | Automated prompt eval suite (run on version change) | Medium | AI-EVAL-01 |
| AI-EXT-01 | Add per-field confidence scoring | Medium | AI-EVAL-02 |
| AI-SRCH-02 | Tune similarity threshold per credential type | Medium | AI-SRCH-03 |
| AI-SRCH-03 | Implement search relevance metrics | Medium | None |
| AI-OBS-02 | Provider health monitoring + circuit breaker alerts | Small | None |
| AI-OBS-03 | Cost tracking per extraction and aggregate | Small | None |

### P2 — Quality Polish

| Story | Title | Effort | Dependencies |
|-------|-------|--------|-------------|
| AI-EXT-02 | OCR preprocessing (deskew, binarization) | Medium | None |
| AI-EXT-03 | Expand PII stripping patterns (intl phone, passport, credit card) | Small | None |
| AI-EXT-04 | Field normalization (jurisdiction, dates, degree levels) | Medium | AI-EVAL-01 |
| AI-SRCH-01 | Weighted embedding text construction | Medium | AI-SRCH-03 |
| AI-SRCH-06 | Re-ranking with metadata signals | Medium | AI-SRCH-03 |
| AI-FRAUD-03 | Issuer-credential type mismatch detection | Small | AI-FRAUD-01 |
| AI-FRAUD-04 | Accreditation status integration (IPEDS/SACSCOC) | Large | None |
| AI-RAG-01 | Nessie RAG pipeline | Large | AI-SRCH-03 |
| AI-RAG-02 | Golden eval set for RAG queries | Medium | AI-RAG-01 |

---

## Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Extraction accuracy (F1, all fields) | Unknown | >0.85 | Eval dataset |
| Confidence calibration (correlation with accuracy) | Unknown | r > 0.80 | Eval dataset |
| Fraud detection precision | Unknown | >80% | Audit of flagged items |
| Fraud detection recall (obvious frauds) | Unknown | >50% | Eval dataset |
| Search precision@10 | Unknown | >0.70 | User click-through |
| User acceptance rate (extraction fields) | Unknown | >75% | extraction_feedback table |
| Provider uptime | Unknown | >99.5% | Health monitoring |
| Mean extraction latency | Unknown | <3s p95 | Structured logs |
| Cost per extraction | Unknown | <$0.002 | Token tracking |

---

_Generated 2026-03-23 by ML Engineer Audit (Session 12)_
