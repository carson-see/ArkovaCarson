# GRE: Gemini Reasoning Engine — Story Group

> Epic: SCRUM-733 | Release: R-GRE-01
> Priority: HIGHEST | Status: 0/7 complete

## Goal

Transform Gemini from a yes/no classifier into a reasoning engine. Every extraction must include: sub-type classification, chain-of-thought reasoning, evidence-based confidence, fraud detection with explanations, and cross-reference verification against pipeline data.

## Stories

| # | ID | Jira | Priority | Story | Phase | Status |
|---|-----|------|----------|-------|-------|--------|
| 1 | GRE-01 | SCRUM-742 | HIGHEST | Define Sub-Type Taxonomy for all 21 types | 1 | NOT STARTED |
| 2 | GRE-02 | SCRUM-743 | HIGHEST | Chain-of-Thought Extraction Prompt | 1 | NOT STARTED |
| 3 | GRE-03 | SCRUM-744 | HIGHEST | Fraud Reasoning Engine (0% → >50% F1) | 2 | NOT STARTED |
| 4 | GRE-04 | SCRUM-745 | HIGH | Cross-Reference Verification | 2 | NOT STARTED |
| 5 | GRE-05 | SCRUM-746 | HIGH | Reasoning Few-Shot Examples (80 new) | 2 | NOT STARTED |
| 6 | GRE-06 | SCRUM-747 | HIGH | Golden Dataset Restructure (sub_type, reasoning) | 1 | NOT STARTED |
| 7 | GRE-07 | SCRUM-748 | HIGH | Confidence Calibration (>0.7 correlation) | 3 | NOT STARTED |

## Dependencies

- GRE-02 depends on GRE-01 (sub-types must be defined before prompt uses them)
- GRE-03 depends on GRE-04 (fraud reasoning needs cross-reference data)
- GRE-05 depends on GRE-01 + GRE-02 (few-shots must match new schema)
- GRE-07 depends on GRE-02 + GRE-04 (calibration uses reasoning + cross-ref)

## Key Metrics

- Fraud F1: 0% → >50%
- Confidence correlation: 0.539 → >0.7
- Sub-types defined: 0 → 100+ across 21 types
- Reasoning coverage: 0% → 100% of extractions
