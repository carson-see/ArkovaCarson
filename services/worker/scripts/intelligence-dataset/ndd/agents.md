# services/worker/scripts/intelligence-dataset/ndd

NDD (Nessie Domain Depth) — 10 stories (SCRUM-780..789) targeting enforcement-decision-level regulatory knowledge per jurisdiction (NY, CA, IL, etc.).

## Files

- `sources.ts` — Anchored source registries per jurisdiction. Hand-verified statutes, enforcement bulletins, and case citations. Every entry has a quote + source label.
- `enforcement.ts` — Enforcement ladder per story. Penalty/severity tiers (CIVIL_MINOR, etc.) backed by the source registry. Data-driven so new scenarios inherit correct tiers.
- `scorer.ts` — Retrieval-accuracy scorer. Deterministic pass/fail against registered retrieval expectations. Pure function, safe for CI.
- `retrieval-tests.ts` — Query-level "must cite any of these sources" retrieval expectations for the RAG harness.
- `types.ts` — Shared types: NddStoryId, NddJurisdictionPack, EnforcementTier, NddRetrievalExpectation.
- `ndd.test.ts` — Unit tests for scorer and retrieval expectations.

## Constraints

- Scaffolding only while NVI gate is active — no LLM calls or tuning submissions.
- Every source entry must have both a quote and a source label; URLs preferred.
