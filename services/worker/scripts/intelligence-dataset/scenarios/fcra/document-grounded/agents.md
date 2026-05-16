# services/worker/scripts/intelligence-dataset/scenarios/fcra/document-grounded

NVI-09 (SCRUM-813) document-grounded FCRA training scenarios. Each scenario pairs a question with a specific document from the FCRA corpus in `documents/fcra-corpus.ts`.

## Files

- `seed-scenarios.ts` — 16 seed scenarios (2 per corpus entry for 8 documents). Target: 150+ via NVI-07 distillation.
- `index.ts` — Re-exports the seed scenario array.

## Constraints

- Every scenario must reference a valid document ID from `documents/fcra-corpus.ts`.
- Citations must use canonical IDs from `sources/fcra-sources.ts`.
