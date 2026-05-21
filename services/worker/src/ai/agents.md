# agents.md — services/worker/src/ai/

_Last updated: 2026-05-16_

## 2026-05-20 Gemini Golden Lane Updates

- `fallback-chain.ts` emits sanitized `provider_fallback` observer events when a retriable provider failure routes to the next provider. Events include provider names and a classified reason only; never prompt text, stripped text, fingerprints, or raw provider error bodies.
- `eval/eval-gates.ts` defines explicit fail-closed merge gates for SCRUM-1962 (CPE) and SCRUM-1963 (CLE ethics hours). Missing Phase 5 dataset coverage fails the gate instead of producing an implicit pass.
- Server-side visual fraud image analysis is disabled at `api/v1/ai-fraud-visual.ts`; SCRUM-1955 owns the client-side worker path that may send structured fraud findings server-side.

## What This Folder Contains

AI provider abstraction layer for credential metadata extraction, fraud detection, embeddings, and compliance intelligence. All providers receive only PII-stripped metadata (Constitution 1.6 / 4A).

| File | Purpose |
|------|---------|
| `types.ts` | `IAIProvider` interface, `ExtractionRequest`/`ExtractionResult`, `EmbeddingResult`, `ProviderHealth` types |
| `factory.ts` | Provider factory — routes to Gemini, Nessie, Together, Cloudflare, Replicate, or Mock based on `AI_PROVIDER` env var |
| `gemini.ts` | Gemini Flash provider — primary production extraction via `@google/generative-ai` SDK |
| `nessie.ts` | Nessie provider — fine-tuned Llama 3.1 8B on RunPod vLLM for pipeline/institutional documents |
| `together.ts` | Together AI provider — OpenAI-compatible inference for Nessie fine-tuned models |
| `cloudflare-fallback.ts` | Cloudflare Workers AI fallback — gated by `ENABLE_AI_FALLBACK`, never primary |
| `replicate.ts` | Replicate provider — QA/synthetic data only, hard-blocked in production |
| `mock.ts` | Deterministic mock provider for tests |
| `schemas.ts` | Zod schemas for extraction request/response validation |
| `gemini-config.ts` | Single source of truth for all Gemini model version pins |
| `structured-output.ts` | Zod-to-Gemini JSON Schema converter for native structured output |
| `confidence-model.ts` | Feature-based nonlinear confidence meta-model (sigmoid + polynomial features) |
| `ensembleConfidence.ts` | Multi-prompt ensemble confidence scoring (3 framings, agreement-weighted) |
| `grounding.ts` | Hallucination detector — cross-checks extracted fields against source text |
| `integrity.ts` | Integrity score service (0-100) — completeness, confidence, verification, duplicates, temporal |
| `crossFieldFraudChecks.ts` | Post-extraction cross-field consistency fraud checks (diploma mills, date logic) |
| `fraudReasoning.ts` | Multi-factor fraud reasoning engine — produces explainable risk assessments |
| `enhanced-fraud-signals.ts` | Gemini 3 enhanced fraud signal categories (watermark, resolution, metadata stripping) |
| `visualFraudDetector.ts` | Document image fraud analysis via Gemini Vision |
| `crossReference.ts` | Cross-reference verification against DAPIP, IPEDS, NPI, FINRA databases |
| `feedback.ts` | User correction feedback service — tracks acceptance/rejection for prompt tuning |
| `review-queue.ts` | Admin review queue for flagged credentials (EU AI Act human-in-the-loop) |
| `report-generator.ts` | Analytics report generation (integrity, accuracy, compliance) |
| `cost-tracker.ts` | AI credit usage tracking per org (Free 50 / Pro 500 / Enterprise 5000 monthly) |
| `batch-processing.ts` | Concurrent batch extraction with per-item failure isolation |
| `embeddings.ts` | 768-dim vector embedding service stored in `credential_embeddings` |
| `multimodal-embedding.ts` | Gemini multimodal embedding for document images (gated by feature flag) |
| `hybrid-search.ts` | BM25 + dense retrieval with Reciprocal Rank Fusion |
| `extraction-manifest.ts` | Cryptographic binding of AI output to source document hash (SHA-256 manifest) |
| `zk-proof.ts` | PLONK zero-knowledge proofs binding extraction manifests to documents |
| `ruleMatcher.ts` | Semantic rule matching via cosine similarity on embeddings |
| `fallback-chain.ts` | Multi-model fallback chain (Gemini Tuned -> Gemini Base -> Nessie -> error) |
| `context-window.ts` | Model-specific context window limits and token budget tracking |
| `deprecation-monitor.ts` | Gemini model deprecation date tracker integrated into health checks |
| `observability.ts` | OpenTelemetry tracing to Arize for AI provider calls |
| `vertex-client.ts` | Vertex AI REST client for tuned model inference |
| `constrained-schemas.ts` | Per-regulation JSON Schema whitelists for vLLM constrained decoding |
| `nessie-domain-router.ts` | Multi-LoRA domain routing (SEC, Academic, Legal, Regulatory adapters) |
| `nessie-quarantine.ts` | Endpoint quarantine for unverified citation models (confidence downgrade) |
| `featureFlags.ts` | Runtime AI feature flags (v6 prompt, tuned endpoint, calibration) |
| `modelTargets.ts` | Dual-model target config (8B server / 3B browser) |
| `strip-json-comments.ts` | Strips JS-style comments from Nessie JSON responses before parsing |
| `trainingMetrics.ts` | Training data quality metrics tracker |

## Do / Don't Rules

- **DO** use `getAIProvider()` from `factory.ts` — never instantiate providers directly
- **DO** validate all extraction results with `ExtractedFieldsSchema` from `schemas.ts`
- **DO** run grounding verification on every extraction result before persisting
- **DO NOT** send raw document bytes or PII to any provider (Constitution 1.6 / 4A)
- **DO NOT** use Replicate in production (hard-blocked, QA-only)
- **DO NOT** use Cloudflare as primary provider (fallback-only, gated by `ENABLE_AI_FALLBACK`)
- **DO NOT** hardcode model names — use `gemini-config.ts` centralized pins
