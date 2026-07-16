# agents.md — services/worker/src/ai/training/

_Last updated: 2026-07-15_

## S3.3 v7.1 release-candidate boundary

The binding v7.1 surgery/export implementation lives in the offline
`services/worker/scripts/s33-v71-surgery.ts`, not in a runtime orchestrator.
Its frozen result is 961 retained source-backed rows (865 train / 96
validation), with 201 fraud rows separated and 1,479 unresolved. The 621-row
S3.3 corpus is heldout evaluation evidence and must never enter training.
Until an authenticated heldout leakage scan, reviewed trust-root activation,
and explicit founder/CTO spend admission exist, only the local offline artifact
writer and inert HOLD request template may be used; no tuning submission or
endpoint deployment is authorized.

## What This Folder Contains

Fine-tuning data pipelines for Nessie (RunPod/Together AI) and Gemini Golden (Vertex AI). Produces stratified JSONL training data from golden datasets, fraud seeds, and intelligence examples.

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export — `formatTrainingExample`, `stratifyByType`, `exportFineTuneData` |
| `finetune-exporter.ts` | Stratified instruction-tuning JSONL exporter with quality filtering |
| `fraud-training-pipeline.ts` | Fraud signal training data generation with positive/negative balancing |
| `gemini-tuning-orchestrator.ts` | Gemini Golden fine-tuning job submission via Google Generative AI API |
| `nessie-training-orchestrator.ts` | End-to-end Nessie fine-tuning run (export, augment, dedupe, submit to RunPod) |
| `nessie-dpo-data.ts` | DPO preference pairs for citation accuracy improvement (SFT first, DPO second) |
| `nessie-intelligence-data.ts` | Compliance intelligence training data (QA, risk, summary, recommendation, cross-ref) |
| `nessie-v4-data.ts` | Nessie v4 data prep — realistic confidence, deduplication, instruction mixing |

## Do / Don't Rules

- **DO** use only PII-stripped metadata in training data (Constitution 1.6 / 4A)
- **DO** deduplicate training examples before export (nessie-v4-data.ts pattern)
- **DO** mix 20-30% general instruction data to prevent catastrophic forgetting
- **DO NOT** include fraud holdout set entries in training data
