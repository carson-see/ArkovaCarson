# GME2: Gemini Golden Evolution (v6-v10+) -- Story Group

> Epic: SCRUM-772 | Release: R-GME2-01
> Priority: HIGHEST | Status: 0/5 complete
> Depends on: GME (20/20 complete -- Gemini 3 Flash migration), GRE (reasoning engine), NPH (golden dataset)

## Goal

Evolve the Gemini Golden fine-tuned model from v3 (current production, 90.4% weighted F1) to v6-v10+, addressing the known gaps: fraud detection (currently 0% F1), confidence calibration (0.539 correlation), limited document format coverage, and English-only extraction. While Nessie handles compliance reasoning, Gemini Golden is the production extraction workhorse -- every document upload goes through it. These improvements directly affect every user's experience.

**Anchoring requirement:** ALL source data used for training ANY version MUST be anchored through the Arkova pipeline before use. This ensures provenance and integrity of training data. No unanchored data may enter the training pipeline.

## Context

### Current State (Gemini Golden v3)

| Metric | Value | Gap |
|--------|-------|-----|
| Weighted F1 | 90.4% | Target >= 95% |
| Macro F1 | 81.4% | Target >= 90% |
| Fraud signal F1 | 0% | Target >= 70% |
| Confidence correlation | 0.539 | Target >= 0.85 |
| Document formats | ~50 known | Target 500+ |
| Languages | English only | Target 8 languages |
| Golden dataset | 2,000+ entries | Need 5,000+ |

### Why Gemini Golden (Not Nessie)

Gemini Golden is the **extraction** model -- it reads documents and extracts structured metadata. Nessie is the **reasoning** model -- it answers compliance questions and provides analysis. They serve different purposes:

- **Gemini Golden:** "What credentials does this PDF contain?" (extraction)
- **Nessie:** "Is this credential compliant with HIPAA in Texas?" (reasoning)

Both need improvement, but Gemini Golden's extraction quality directly gates every document upload in the product.

## Stories

| # | ID | Jira | Priority | Story | Status |
|---|-----|------|----------|-------|--------|
| 1 | GME2-01 | SCRUM-792 | HIGHEST | Fraud Detection Mastery | NOT STARTED |
| 2 | GME2-02 | SCRUM-793 | HIGHEST | Document Format Encyclopedia | NOT STARTED |
| 3 | GME2-03 | SCRUM-794 | HIGHEST | Confidence Calibration | NOT STARTED |
| 4 | GME2-04 | SCRUM-795 | HIGH | Multi-Language Extraction | NOT STARTED |
| 5 | GME2-05 | SCRUM-796 | HIGH | Domain-Specific Extraction | NOT STARTED |

---

### GME2-01: Fraud Detection Mastery (100+ Patterns)

**Jira:** [SCRUM-792](https://arkova.atlassian.net/browse/SCRUM-792)

**Description:** Train Gemini Golden v6 to detect credential fraud with high precision. Current fraud signal extraction is at 0% F1 -- this is the single most critical gap in the extraction pipeline. Gemini's multimodal vision capabilities make it the right model for visual fraud detection (unlike text-only Nessie).

**Training Data Scope (100+ fraud patterns):**
- **Diploma mills:** Visual patterns (template reuse, generic seals, missing accreditation marks)
- **License forgery:** Incorrect formats, invalid license numbers, wrong board names, font inconsistencies
- **Photoshop artifacts:** JPEG compression anomalies, metadata inconsistencies, layer artifacts
- **Certificate fraud:** Missing security features (watermarks, holograms, embossing references)
- **Accreditation fraud:** Non-recognized accreditors, accreditation mill visual patterns
- **Temporal anomalies:** Future dates, impossible timelines, anachronistic formatting
- **Cross-reference failures:** Credentials that don't match known issuer patterns

**Acceptance Criteria:**
- [ ] v6 detects fraud patterns with >= 70% F1 (from 0%)
- [ ] v6 includes fraud reasoning in extraction output (why flagged)
- [ ] v6 identifies >= 100 distinct fraud pattern types
- [ ] False positive rate <= 5% (precision is critical -- false fraud accusations are harmful)
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] NPH-12 fraud training pipeline data available (>= 500 fraud examples)
- [ ] GRE-03 fraud reasoning engine complete
- [ ] NSS-07 credential fraud encyclopedia available (or concurrent development)
- [ ] Legitimate credential examples available for negative training (>= 2,000)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v6 model trained on Vertex AI and deployed
- [ ] Fraud detection eval suite (200+ test cases, balanced fraud/legitimate)
- [ ] Fraud F1 >= 70% measured on held-out test set
- [ ] False positive rate measured and <= 5%
- [ ] Eval report in `docs/eval/`
- [ ] GEMINI_TUNED_MODEL updated in Cloud Run

---

### GME2-02: Document Format Encyclopedia (500+ Formats)

**Jira:** [SCRUM-793](https://arkova.atlassian.net/browse/SCRUM-793)

**Description:** Train Gemini Golden v7 to recognize and correctly parse 500+ document formats. Current coverage is approximately 50 known formats. Users upload documents in wildly varying formats -- state-specific license certificates, international degree templates, professional certification cards, insurance declarations, military discharge papers, etc.

**Training Data Scope (500+ formats):**
- **US state licenses:** All 50 states x top 10 license types = 500+ format variations
- **Degrees:** Major universities (top 100 US + top 50 international), community colleges, online universities
- **Professional certifications:** CPA, CFA, PMP, CISSP, AWS, etc. -- each has a distinct certificate format
- **Insurance:** Declarations pages, binders, certificates of insurance, surplus lines
- **Military:** DD-214, DD-256, NGB-22, military awards/decorations
- **International:** UK, EU, Australian, Kenyan credential formats
- **Digital formats:** PDF certificates, badge images, QR-verified credentials, blockchain-issued

**Acceptance Criteria:**
- [ ] v7 correctly identifies document type for >= 90% of 500+ formats
- [ ] v7 extracts key fields (name, date, issuer, number) from identified formats
- [ ] v7 handles poor quality scans (low DPI, skewed, partially occluded)
- [ ] Format recognition eval covers all 50 US states
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v6 model available as training base
- [ ] Document format samples collected (>= 5 examples per format, >= 2,500 total)
- [ ] Format taxonomy defined (type > format > variant)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v7 model trained on Vertex AI and deployed
- [ ] Format recognition eval suite (500+ test documents)
- [ ] Per-format accuracy breakdown
- [ ] Eval report in `docs/eval/`

---

### GME2-03: Confidence Calibration (Target > 0.85 Correlation)

**Jira:** [SCRUM-794](https://arkova.atlassian.net/browse/SCRUM-794)

**Description:** Fix Gemini Golden's confidence calibration. Current confidence-accuracy correlation is 0.539 (v5 eval) -- the model doesn't know when it's wrong. Overconfidence at the 90-100% bucket shows a 29.7pp gap (reports 90%+ confidence but only 65.8% actual accuracy). This must be fixed through training, not just post-hoc calibration.

**Approach:**
- **Calibration training:** Include confidence-labeled training examples where the model learns to output lower confidence for ambiguous documents
- **Hard negative mining:** Train on documents where previous versions were wrong but confident
- **Temperature tuning:** Optimize generation temperature for calibrated confidence
- **Platt scaling:** Post-hoc calibration as a safety net, but training-based calibration is primary

**Acceptance Criteria:**
- [ ] v8 confidence-accuracy correlation >= 0.85 (from 0.539)
- [ ] Overconfidence gap in 90-100% bucket <= 5pp (from 29.7pp)
- [ ] ECE (Expected Calibration Error) <= 5% (from ~10%)
- [ ] Reliability diagram shows calibrated S-curve
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v7 model available as training base
- [ ] Hard negative corpus prepared from v3-v7 eval failures (>= 500 examples)
- [ ] Confidence-labeled training pairs prepared (>= 1,000)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v8 model trained on Vertex AI and deployed
- [ ] Calibration eval suite with reliability diagram
- [ ] Correlation measured and >= 0.85
- [ ] ECE measured and <= 5%
- [ ] Eval report in `docs/eval/`

---

### GME2-04: Multi-Language Extraction (8 Languages)

**Jira:** [SCRUM-795](https://arkova.atlassian.net/browse/SCRUM-795)

**Description:** Extend Gemini Golden v9 to extract credential metadata from documents in 8 languages. Current extraction is English-only. International expansion (Kenya, Australia, EU, UK) and US immigrant credential verification require multi-language support.

**Target Languages:**
1. **English** (baseline -- maintain quality)
2. **Spanish** (US bilingual documents, Latin American credentials)
3. **French** (Canadian bilingual, African francophone countries)
4. **Swahili** (Kenya -- early client market)
5. **Arabic** (Middle Eastern credentials, growing US verification demand)
6. **Mandarin Chinese** (Chinese university transcripts, professional certifications)
7. **Portuguese** (Brazilian credentials)
8. **German** (EU professional qualifications, engineering certifications)

**Acceptance Criteria:**
- [ ] v9 extracts metadata from documents in all 8 languages
- [ ] Per-language extraction F1 >= 80%
- [ ] English extraction quality does not regress below v8 baseline
- [ ] Handles bilingual documents (e.g., Spanish/English, French/English)
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v8 model available as training base
- [ ] Multi-language golden dataset prepared (>= 100 examples per language, >= 800 total)
- [ ] Translation verification completed for non-English training data
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v9 model trained on Vertex AI and deployed
- [ ] Per-language eval suite (50+ examples per language)
- [ ] Per-language F1 breakdown
- [ ] Eval report in `docs/eval/`
- [ ] No English regression (F1 stays >= v8)

---

### GME2-05: Domain-Specific Extraction (Medical/Legal/Financial Field Patterns)

**Jira:** [SCRUM-796](https://arkova.atlassian.net/browse/SCRUM-796)

**Description:** Train Gemini Golden v10 to extract domain-specific fields that generic extraction misses. Different credential domains have unique fields that matter:

**Domain-Specific Fields:**
- **Medical:** NPI number, DEA number, board certification specialty, privileges, malpractice history flags
- **Legal:** Bar number, jurisdiction(s), practice areas, pro hac vice status, disciplinary status
- **Financial:** CRD number, Series licenses (7, 63, 65, 66), RIA registration, disclosures
- **Engineering:** PE number, discipline, sealing authority, state-specific endorsements
- **Education:** Accreditation body, program-level vs. institutional accreditation, NCES unit ID
- **Insurance:** NPN (National Producer Number), lines of authority, surplus lines eligibility
- **Real estate:** License type (salesperson vs. broker), NMLS ID for mortgage

**Acceptance Criteria:**
- [ ] v10 extracts domain-specific fields for medical, legal, and financial credentials
- [ ] NPI/DEA extraction accuracy >= 95% for medical documents
- [ ] Bar number/jurisdiction extraction accuracy >= 95% for legal documents
- [ ] CRD/Series extraction accuracy >= 90% for financial documents
- [ ] Generic extraction quality does not regress
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v9 model available as training base
- [ ] Domain-specific training data prepared (>= 200 per domain, >= 1,000 total)
- [ ] Field taxonomy defined per domain
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v10 model trained on Vertex AI and deployed
- [ ] Per-domain extraction eval suite (100+ per domain)
- [ ] Per-field accuracy breakdown
- [ ] Eval report in `docs/eval/`
- [ ] No generic extraction regression

## Dependencies

```
GME (v1-v5 complete) ─► GME2 (v6-v10+)
                          │
                          ├── NPH-12 (fraud training data) ─► GME2-01
                          ├── GRE-03 (fraud reasoning) ─► GME2-01
                          ├── NSS-07 (fraud encyclopedia) ─► GME2-01
                          └── KAU (international data) ─► GME2-04

GME2 training order:
  GME2-01 (v6 fraud) ─► GME2-02 (v7 formats) ─► GME2-03 (v8 calibration) ─► GME2-04 (v9 languages) ─► GME2-05 (v10 domains)
```

- GME2-01 depends on: NPH-12 (fraud data), GRE-03 (fraud reasoning), NSS-07 (fraud encyclopedia -- can develop concurrently)
- GME2-02 depends on: GME2-01 (v6 as base)
- GME2-03 depends on: GME2-02 (v7 as base), eval failures from v6-v7 for hard negatives
- GME2-04 depends on: GME2-03 (v8 as base), KAU (international data for non-English)
- GME2-05 depends on: GME2-04 (v9 as base)

## Key Metrics

| Metric | Golden v3 (Current) | v6 Target | v8 Target | v10 Target |
|--------|---------------------|-----------|-----------|------------|
| Weighted F1 | 90.4% | >= 91% | >= 93% | >= 95% |
| Macro F1 | 81.4% | >= 83% | >= 87% | >= 90% |
| Fraud F1 | 0% | >= 70% | >= 75% | >= 80% |
| Confidence correlation | 0.539 | >= 0.60 | >= 0.85 | >= 0.85 |
| Document formats | ~50 | ~100 | ~300 | >= 500 |
| Languages | 1 | 1 | 1 | 8 |
| Domain-specific fields | 0 | 0 | 0 | 3+ domains |

## Vertex AI Training Notes

Gemini Golden trains on **Vertex AI** (not RunPod like Nessie). Training procedure:
1. Prepare JSONL training data in Vertex AI format
2. Upload to GCS bucket
3. Create fine-tuning job via `gcloud ai custom-jobs create` or Vertex AI console
4. Monitor training metrics (loss, accuracy per epoch)
5. Deploy model to endpoint
6. Update `GEMINI_TUNED_MODEL` env var in Cloud Run

Current training infrastructure:
- **GCP project:** arkova1 (project ID: 270018525501)
- **Region:** us-central1
- **Current endpoint:** `projects/270018525501/locations/us-central1/endpoints/481340352117080064`
- **Base model:** gemini-3-flash (migrated from gemini-2.5-flash per GME epic)

## Anchoring Policy

**Non-negotiable:** Every piece of training data -- document samples, fraud examples, format templates, multi-language examples, domain-specific extractions -- MUST be anchored through the Arkova pipeline before it enters any training run. This creates an immutable audit trail proving:

1. What data trained each model version
2. When that data was anchored (timestamped on-chain)
3. That the data has not been tampered with post-anchoring

Training runs that use unanchored data are invalid and must be re-run after anchoring. For Gemini Golden specifically, the training data often contains document images -- these must be fingerprinted and anchored even though the images themselves stay on-device per the client-side processing boundary (Constitution 1.6). The anchored record references the fingerprint, not the raw document.
