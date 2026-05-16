# services/worker/scripts/intelligence-dataset/documents

NVI-09 (SCRUM-813) synthetic document corpus for document-grounded training scenarios.

## Files

- `fcra-corpus.ts` — 8 seed synthetic/anonymized FCRA documents (adverse-action notices, dispute letters, etc.). Every entry is synthetic or PII-stripped to `[REDACTED]` with an `anonymisedAt` certification date. Target: 70+ via distillation + anonymized production samples.

## Constraints

- No real PII. Every entry must be synthetic or carry a certified anonymization date.
- Document ids are referenced by scenarios in `scenarios/fcra/document-grounded/`.
