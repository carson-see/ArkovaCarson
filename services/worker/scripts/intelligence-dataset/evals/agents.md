# services/worker/scripts/intelligence-dataset/evals

Hand-crafted 50-question evaluation sets per regulatory domain. Used with the eval runner to measure model accuracy against canonical citations.

## Files

- `fcra-eval.ts` — 50 FCRA eval questions across 11 categories. Task types: compliance_qa (20), risk_analysis (12), recommendation (8), cross_reference (6), document_summary (4). Citations use canonical IDs from `sources/fcra-sources.ts`.
- `ferpa-eval.ts` — 50 FERPA eval questions across 10 categories. Citations from `sources/ferpa-sources.ts`.
- `hipaa-eval.ts` — 50 HIPAA eval questions across 5 categories. Citations from `sources/hipaa-sources.ts`.

## Constraints

- All `expectedCitations` must reference canonical IDs from the corresponding `sources/` registry.
- Eval questions must not overlap with training scenarios to avoid self-eval bias.
