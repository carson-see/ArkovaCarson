# NTF: Nessie Training Foundation (v6-v16) -- Story Group

> Epic: SCRUM-769 | Release: R-NTF-01
> Priority: HIGHEST | Status: 2/7 complete (1 training, 4 queued)
> Depends on: NMT (14/14 complete), NPH (golden dataset expansion), GRE (reasoning engine)

## Goal

Build the deep training foundation that takes Nessie from a credential classifier to a compliance reasoning expert. Versions v6-v16 progressively add reasoning, compliance Q&A, cross-reference verification, multi-jurisdiction analysis, adversarial conflict resolution, and audit/investigation reasoning. Each version builds on the previous -- no version may skip its predecessor.

**Anchoring requirement:** ALL source data used for training ANY version MUST be anchored through the Arkova pipeline before use. This ensures provenance and integrity of training data. No unanchored data may enter the training pipeline.

## Stories

| # | ID | Jira | Priority | Story | Versions | Status |
|---|-----|------|----------|-------|----------|--------|
| 1 | NTF-01 | SCRUM-773 | HIGHEST | Baseline + Reasoning Foundation | v6-v8 | **DONE** |
| 2 | NTF-02 | SCRUM-774 | HIGHEST | Advanced Reasoning + Deep Training | v9-v11 | **DONE** |
| 3 | NTF-03 | SCRUM-775 | HIGHEST | Compliance Q&A Mastery | v12 | TRAINING |
| 4 | NTF-04 | SCRUM-776 | HIGH | Cross-Reference Verification | v13 | QUEUED |
| 5 | NTF-05 | SCRUM-777 | HIGH | Multi-Jurisdiction Analysis | v14 | QUEUED |
| 6 | NTF-06 | SCRUM-778 | HIGH | Adversarial Compliance Conflicts | v15 | QUEUED |
| 7 | NTF-07 | SCRUM-779 | HIGH | Audit & Investigation Reasoning | v16 | QUEUED |

---

### NTF-01: v6-v8 Baseline + Reasoning Foundation -- DONE

**Jira:** [SCRUM-773](https://arkova.atlassian.net/browse/SCRUM-773)

**Description:** Establish the foundation for Nessie's reasoning capabilities across three training versions:
- **v6:** Retrain on expanded golden dataset (post-NPH-13 expansion) with balanced type distribution
- **v7:** Add chain-of-thought reasoning to extraction output (building on GRE-02 prompt work)
- **v8:** Introduce sub-type classification across all 21 credential types

**Acceptance Criteria:**
- [x] v6 trained on golden dataset with >= 50 entries per credential type
- [x] v7 produces chain-of-thought reasoning in extraction JSON
- [x] v8 classifies sub-types matching GRE-01 taxonomy
- [x] All training data anchored through pipeline before use
- [x] Eval results documented with per-version comparison
- [x] Weighted F1 >= 88% (improvement over v5's 87.2%)

**DoR:**
- [x] Golden dataset expanded to >= 2,500 entries
- [x] Sub-type taxonomy defined (GRE-01)
- [x] Reasoning prompt format finalized (GRE-02)
- [x] RunPod GPU capacity confirmed
- [x] All training source data anchored on-chain

**DoD:**
- [x] v6, v7, v8 models trained and uploaded to RunPod
- [x] Eval suite run against all three versions (100+ samples each)
- [x] Results in `docs/eval/`
- [x] Model IDs updated in environment config
- [x] No regression in any credential type below v5 baseline

---

### NTF-02: v9-v11 Advanced Reasoning + Deep Training -- DONE

**Jira:** [SCRUM-774](https://arkova.atlassian.net/browse/SCRUM-774)

**Description:** Deepen Nessie's reasoning capabilities and training intensity:
- **v9:** Evidence-based confidence scoring (addressing 0.539 correlation gap)
- **v10:** Fraud signal extraction (addressing 0% F1 gap -- target >= 30%)
- **v11:** Deep training with DPO/RLHF on hard cases (misclassified examples from v6-v8)

**Acceptance Criteria:**
- [x] v9 confidence correlation > 0.65 (up from 0.539)
- [x] v10 fraud signal F1 > 30% (up from 0%)
- [x] v11 trained with preference optimization on hard cases
- [x] All training data anchored through pipeline before use
- [x] Eval comparison across v6-v11

**DoR:**
- [x] v8 model available and eval baseline established
- [x] Fraud training examples >= 200 (from NPH-12 pipeline)
- [x] Hard case corpus identified from v6-v8 eval failures
- [x] All training source data anchored on-chain

**DoD:**
- [x] v9, v10, v11 models trained and uploaded
- [x] Confidence correlation measured and documented
- [x] Fraud F1 measured and documented
- [x] Eval reports in `docs/eval/`
- [x] DPO training documented with preference pair counts

---

### NTF-03: v12 Compliance Q&A Mastery -- TRAINING

**Jira:** [SCRUM-775](https://arkova.atlassian.net/browse/SCRUM-775)

**Description:** Train Nessie v12 to answer compliance questions with regulatory accuracy. Nessie must understand and reason about:
- **FERPA:** Directory information, disclosure logging, requester verification
- **HIPAA:** MFA requirements, audit logging, BAA obligations, breach procedures
- **SOX:** Internal controls, auditor independence, financial disclosure
- **Fraud detection:** Pattern recognition, diploma mills, fake accreditors, license format validation
- **International:** Kenya DPA, Australia Privacy Act, GDPR fundamentals

**Acceptance Criteria:**
- [ ] v12 answers FERPA questions with >= 85% accuracy
- [ ] v12 answers HIPAA questions with >= 85% accuracy
- [ ] v12 answers SOX/SEC questions with >= 80% accuracy
- [ ] v12 identifies fraud patterns with >= 40% F1
- [ ] v12 handles international compliance questions for Kenya, Australia
- [ ] All training data anchored through pipeline before use

**DoR:**
- [x] v11 model available as training base
- [x] Compliance Q&A training dataset prepared (>= 500 Q&A pairs)
- [x] FERPA/HIPAA/SOX regulatory text ingested (NCX-01)
- [ ] International compliance data ingested (KAU-01, KAU-03)
- [x] All training source data anchored on-chain

**DoD:**
- [ ] v12 model trained and uploaded to RunPod
- [ ] Compliance Q&A eval suite created (200+ questions)
- [ ] Per-domain accuracy breakdown documented
- [ ] Eval report in `docs/eval/`
- [ ] No regression below v11 extraction baseline

---

### NTF-04: v13 Cross-Reference Verification -- QUEUED

**Jira:** [SCRUM-776](https://arkova.atlassian.net/browse/SCRUM-776)

**Description:** Train Nessie v13 to cross-reference extracted credential data against pipeline public records (1.41M+ anchored records). Nessie must verify:
- License numbers against state board registries
- Degree claims against NCES/Clearinghouse data
- SEC filings against EDGAR records
- Business entity status against SOS records

**Acceptance Criteria:**
- [ ] v13 uses pipeline data for cross-reference verification
- [ ] License number validation accuracy >= 90%
- [ ] Education verification accuracy >= 85%
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v12 model available as training base
- [ ] Cross-reference training pairs generated from pipeline data
- [ ] Pipeline API for record lookup available
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v13 model trained and uploaded
- [ ] Cross-reference eval suite (100+ verification pairs)
- [ ] Eval report in `docs/eval/`

---

### NTF-05: v14 Multi-Jurisdiction Analysis -- QUEUED

**Jira:** [SCRUM-777](https://arkova.atlassian.net/browse/SCRUM-777)

**Description:** Train Nessie v14 to understand and compare regulatory requirements across multiple jurisdictions simultaneously. When a credential holder operates in multiple states or countries, Nessie must identify which requirements apply, where conflicts exist, and what the most restrictive applicable standard is.

**Acceptance Criteria:**
- [ ] v14 compares requirements across 2+ jurisdictions
- [ ] Identifies the most restrictive standard correctly >= 80% of the time
- [ ] Detects jurisdiction-specific exemptions
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v13 model available as training base
- [ ] Multi-jurisdiction training scenarios prepared (100+)
- [ ] NDD domain training data available
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v14 model trained and uploaded
- [ ] Multi-jurisdiction eval suite
- [ ] Eval report in `docs/eval/`

---

### NTF-06: v15 Adversarial Compliance Conflicts -- QUEUED

**Jira:** [SCRUM-778](https://arkova.atlassian.net/browse/SCRUM-778)

**Description:** Train Nessie v15 on adversarial scenarios where compliance requirements genuinely conflict. Examples: FERPA vs. state sunshine laws, HIPAA minimum necessary vs. subpoena obligations, multi-state licensure with contradictory CE requirements. Nessie must identify the conflict, cite both sides, and recommend resolution paths.

**Acceptance Criteria:**
- [ ] v15 identifies genuine compliance conflicts >= 75% of the time
- [ ] Provides balanced analysis citing both conflicting requirements
- [ ] Recommends resolution paths with precedent references
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v14 model available as training base
- [ ] Adversarial conflict training scenarios prepared (100+)
- [ ] Legal precedent data available for conflict resolution
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v15 model trained and uploaded
- [ ] Adversarial conflict eval suite
- [ ] Eval report in `docs/eval/`

---

### NTF-07: v16 Audit & Investigation Reasoning -- QUEUED

**Jira:** [SCRUM-779](https://arkova.atlassian.net/browse/SCRUM-779)

**Description:** Train Nessie v16 to reason about audit and investigation scenarios. Nessie must understand audit procedures, investigation workflows, evidence chain requirements, and regulatory enforcement patterns. Target use cases: SOC 2 evidence collection, HIPAA breach investigation timelines, FERPA complaint response, state board disciplinary proceedings.

**Acceptance Criteria:**
- [ ] v16 generates audit-quality reasoning chains
- [ ] Understands evidence chain requirements
- [ ] Identifies investigation timeline requirements by regulation
- [ ] All training data anchored through pipeline before use

**DoR:**
- [ ] v15 model available as training base
- [ ] Audit/investigation training scenarios prepared (100+)
- [ ] Enforcement action data available (NCX-02)
- [ ] All training source data anchored on-chain

**DoD:**
- [ ] v16 model trained and uploaded
- [ ] Audit reasoning eval suite
- [ ] Eval report in `docs/eval/`

## Dependencies

```
NTF-01 (v6-v8) ─► NTF-02 (v9-v11) ─► NTF-03 (v12) ─► NTF-04 (v13) ─► NTF-05 (v14) ─► NTF-06 (v15) ─► NTF-07 (v16)
                                         │
                                         ├── NCX (compliance data)
                                         ├── KAU (Kenya/AU data)
                                         └── NDD (domain depth)
```

- NTF-01 depends on: NPH-13 (golden dataset expansion), GRE-01 (sub-type taxonomy), GRE-02 (reasoning prompt)
- NTF-02 depends on: NTF-01, NPH-12 (fraud training data)
- NTF-03 depends on: NTF-02, NCX-01 (regulatory text), KAU-01/03 (international data)
- NTF-04 depends on: NTF-03, pipeline public records API
- NTF-05 depends on: NTF-04, NDD (jurisdiction expertise data)
- NTF-06 depends on: NTF-05
- NTF-07 depends on: NTF-06, NCX-02 (enforcement actions)

## Key Metrics

| Metric | v5 Baseline | v8 Target | v12 Target | v16 Target |
|--------|-------------|-----------|------------|------------|
| Weighted F1 | 87.2% | >= 88% | >= 90% | >= 92% |
| Macro F1 | 75.7% | >= 80% | >= 85% | >= 88% |
| Fraud F1 | 0% | >= 10% | >= 40% | >= 60% |
| Confidence correlation | 0.539 | >= 0.65 | >= 0.75 | >= 0.80 |
| Compliance Q&A accuracy | N/A | N/A | >= 85% | >= 90% |

## Anchoring Policy

**Non-negotiable:** Every piece of training data -- regulatory text, golden dataset entries, Q&A pairs, enforcement actions, cross-reference records -- MUST be anchored through the Arkova pipeline before it enters any training run. This creates an immutable audit trail proving:

1. What data trained each model version
2. When that data was anchored (timestamped on-chain)
3. That the data has not been tampered with post-anchoring

Training runs that use unanchored data are invalid and must be re-run after anchoring.
