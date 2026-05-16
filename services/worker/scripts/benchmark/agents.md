# services/worker/scripts/benchmark

NVI-12 (SCRUM-816) LLM-as-judge benchmark framework. Orchestrates candidate models (Nessie, frontier LLMs) answering compliance questions, scored by multiple judges (Opus, GPT-4o, Gemini 2.5 Pro). Flags disagreements (>= 2 tier gap) for human attorney review.

## Files

- `runner.ts` — Pure-function benchmark orchestrator. I/O-free; takes injected CandidateModel + Judge interfaces.
- `runner.test.ts` — Tests using MockCandidate + MockJudge.
- `opus-judge.ts` — Claude Opus judge adapter. Renders rubric into prompt, parses JSON verdict. Do NOT import in tests.
- `types.ts` — Shared interfaces: CandidateModel, Judge, JudgeScore, BenchmarkRun, QuestionResult.

## Constraints

- Tests must use MockCandidate + MockJudge, never real LLM adapters.
- Judge disagreement (>= 2 tiers) triggers NVI-05 Tier 3 human spot-check.
