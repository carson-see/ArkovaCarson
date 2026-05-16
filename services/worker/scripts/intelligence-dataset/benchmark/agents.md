# services/worker/scripts/intelligence-dataset/benchmark

NVI-11 (SCRUM-815) professionally-authored FCRA gold-standard benchmark. Held-out evaluation questions authored by external FCRA compliance attorneys, scored by the LLM-as-judge framework in `scripts/benchmark/`.

## Files

- `benchmark.ts` — Benchmark question shape + `ensureHeldOut()` guard that prevents training-set contamination. Defines the attorney deliverable structure (question, referenceAnswer, requiredCitations, rubric with 0-4 tiers).
- `benchmark.test.ts` — Tests for held-out enforcement and question shape validation.
- `fcra-gold-standard.ts` — Placeholder slots for 50 attorney-authored questions (10 pre-adverse, 10 adverse-action, 8 permissible-purpose, 6 disputes, 6 state, 6 risk, 4 cross-reg). Provisional in-house skeletons pending attorney engagement.

## Constraints

- Benchmark questions must NEVER appear in training data — `ensureHeldOut()` enforces this.
- Each question requires `authorCredential` (bar number / firm / date) before finalization.
