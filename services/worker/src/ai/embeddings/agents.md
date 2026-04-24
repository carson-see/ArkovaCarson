# agents.md — services/worker/src/ai/embeddings/

_Last updated: 2026-04-23_

## What This Folder Contains

Gemini Embedding 2 on Vertex AI — reference client for the GEMB2 epic
([SCRUM-1040](https://arkova.atlassian.net/browse/SCRUM-1040)). Not on the
production hot path yet.

| File | Purpose |
|------|---------|
| `gemini2.ts` | `Gemini2Client` factory with injectable `AuthProvider` + `FetchLike`. US-only residency guard, pinned model id (`gemini-embedding-2@001`), Matryoshka dim whitelist (768 \| 1536 \| 3072), 30 s default `AbortController` timeout. |
| `gemini2.test.ts` | 14 unit tests covering endpoint URL, bearer-token shape, dim defaults, residency guard, 429 / dim-mismatch / empty-text / empty-token / missing-project error paths, abort signal propagation, default-timeout installation + opt-out. |

## Conventions

- **No live Vertex calls from unit tests.** Every test injects a stub `FetchLike`. The only place that touches the network is `services/worker/scripts/benchmark-gemini2.ts`, which is human-run with ADC.
- **Model ID is pinned.** `GEMB2_MODEL = 'gemini-embedding-2@001'`. Never use `latest`. Past incident (Gemini Golden F1 dropped 3 pts overnight on a silent `latest` rotation) is why.
- **US-only residency.** The client throws on any `location !== us-central1`. This is a hard gate tied to CLAUDE.md §1.4. A future cross-region rollout must edit `GEMB2_LOCATION`, update the Confluence residency page, and pass Security review in the same PR.
- **Service-account auth only.** The client receives an `AuthProvider`; implementations come from `google-auth-library` ADC (benchmark script) or Cloud Run metadata (future production wire-up). **No raw API keys in this path.**

## Related

- Parent client interface: [`../types.ts`](../types.ts) — `IAIProvider`. The GEMB2-02 switch-over ([SCRUM-1051](https://arkova.atlassian.net/browse/SCRUM-1051)) will add an adapter that makes `Gemini2Client` a drop-in provider behind `AI_PROVIDER`.
- Legacy embedder (API-key auth, `gemini-embedding-001`): [`../embeddings.ts`](../embeddings.ts). Do not delete until GEMB2-02 ships.
- Benchmark harness: [`../../scripts/benchmark-gemini2.ts`](../../scripts/benchmark-gemini2.ts).
- Design doc: [`docs/design/gemb2/gemb2-01-spike.md`](../../../../../docs/design/gemb2/gemb2-01-spike.md).

## What NOT to do here

- Do not wire this into `retrieval.ts` / `ruleMatcher.ts` / any production hot path yet. That ships with GEMB2-02 behind `ENABLE_GEMB2_RAG`.
- Do not add a fourth `GembDim` value without updating the Matryoshka trade-off table in the spike doc.
- Do not remove the residency guard for "test convenience" — use an injected `FetchLike` instead.
