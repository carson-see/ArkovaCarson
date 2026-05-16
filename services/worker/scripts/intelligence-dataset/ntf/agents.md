# services/worker/scripts/intelligence-dataset/ntf

NTF (Nessie Training Framework) stories (SCRUM-773..779). Evaluation harnesses for reasoning quality, cross-reference verification, credential portability, regulatory conflict resolution, audit findings, and LoRA ablation.

## Files

- `reasoning-quality.ts` — NTF-01/02. Scores chain-of-thought against coherence, factual accuracy, and completeness rubrics. Pure heuristics, no LLM calls.
- `lora-ablation.ts` — NTF-02. LoRA rank sweep winner selector. Picks the rank that ships v6 based on macro F1, per-type F1 min, and confidence correlation. Pure function.
- `lora-ablation.test.ts` — Tests for ablation selection logic.
- `compliance-qa-eval.ts` — NTF-03. FERPA/HIPAA/SOX compliance-Q&A eval harness. Scores against expected key points, risks, and minimum confidence.
- `cross-ref-verification.ts` — NTF-04. Credential cross-reference scorer (NPPES, bar, IPEDS, SEC IAPD, expired licenses, patent theft, diploma mills).
- `portability.ts` — NTF-05. Interstate credential portability analyzer (compacts: NLC, ASWB, PSY-PACT, PTC, IMLCC, etc.).
- `regulatory-conflict.ts` — NTF-06. Federal vs state preemption conflict resolver (FLOOR/CEILING/EXPRESS/FIELD/NONE postures).
- `audit-finding.ts` — NTF-07. Audit finding template validator + severity classifier (COSO/PCAOB: control deficiency, significant deficiency, material weakness).
- `ntf.test.ts` — Umbrella tests for NTF modules.

## Constraints

- All modules are pure functions — no LLM calls, no network I/O.
- Tests cover every branch; these are reference implementations for the eval harness.
