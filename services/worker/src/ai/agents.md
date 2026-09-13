# agents.md — services/worker/src/ai/

_Last updated: 2026-09-12_

## 2026-09-12 `cost-tracker.ts` — `ensureAICreditsPeriod` auto-provisions the current `ai_credits` period (SCRUM-4939)

Since PR #2442 made `check_ai_credits` / `deduct_ai_credits` fail CLOSED when no `ai_credits` row
covers the caller's current period, every org with no row got a hard 503 `credit_system_unavailable`
on its very first AI extraction — nothing had ever provisioned that row (no trigger, cron, or code
path did it). The CTO manually seeded rows for known orgs as a stopgap; this is the permanent fix.

`ensureAICreditsPeriod(orgId, now = new Date())` selects for a row covering `now` (mirroring
`deduct_ai_credits`'s own `period_start <= now AND period_end > now` window, not an exact match on a
calendar-aligned `period_start`) and inserts one only when none exists, using
`config.aiCreditsMonthlyAllocation` (env `AI_CREDITS_MONTHLY_ALLOCATION`, default 100 — see
`docs/reference/ENV.md`) and `used_this_month: 0`. It never overwrites an existing row.

The allocation is read from the **typed config**, not `process.env` directly: the Dependency Scanning
`check-worker-env-adhoc` gate (SCRUM-1258) rejects new ad-hoc `process.env` reads in the worker, and a
Cloud Run env typo on a direct read would silently provision the wrong entitlement. The default 100
matches every operator-seeded prod row (verified against prod 2026-09-12: 16 orgs, 16/16
current-period rows at `monthly_allocation = 100`), so turning this on cannot change an existing org's
entitlement.

**No unique constraint exists on `(org_id, period_start)`** — `ai_credits` only has a primary key on
`id` (`supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`) — so this is a select-then-insert,
not an upsert. That absence is also why the lookup uses the period-covering window instead of an exact
`period_start` match: `deduct_ai_credits`'s `UPDATE` has no row limit, so a second, overlapping-period
row for the same org would let a future deduction silently double-increment two rows at once — the org
would burn credits at 2x for the rest of the month.

**That TOCTOU window is closed in application code, not by a constraint.** Adding a unique index on
`(org_id, period_start)` would be DDL on a table read by every extraction — its own migration, its own
lock-timeout review (CLAUDE.md §1.2), and a T3 PR. Instead, `ensureAICreditsPeriod` **re-reads after
its insert** (`reconcileConcurrentPeriodInsert`): if more than one row now covers the period, every
racer computes the same keeper — the lowest `(created_at, id)`, i.e. the row that existed first and
therefore carries the `>=` usage count — and the loser deletes **only the row it just inserted**, by
id. A pre-existing row can never be deleted by this path, the keeper never deletes itself, so at most
one racer deletes and at least one row always survives. If the compensating delete fails, the
duplicate is left in place and logged at `error` level for operator reconciliation. The caller's own
`deduct_ai_credits` call remains the actual gate either way.

Still unclosed, deliberately: a unique `(org_id, period_start)` index remains the correct permanent
fix and should land as its own T3 migration. This reduces the race window to "both inserts land AND
the loser's compensating delete fails", it does not eliminate it.

Wired in before the debit in both fail-closed callers: `api/v1/ai-extract.ts` calls it immediately
before `deductAICredits` (only when `orgId` is defined); `api/v1/ai-extract-batch.ts` calls it once
before `checkAICredits`, not per-row before each per-item debit, because the batch route latches
`hasFiniteCredits` from that single `checkAICredits` call and reuses it for every row in the batch —
provisioning after that point would leave `hasFiniteCredits` stale for the whole request. Both call sites
skip the call when `orgId` is undefined; user-only credit rows are out of scope for this fix.

`ai-search.ts` and `ai-verify-search.ts` were deliberately NOT touched — see the api/v1 `agents.md`
2026-06-24 entry: they debit AFTER the work is already done and are a different (still fail-open) defect
class, not "the same deduct pattern" this fix addresses.

## 2026-08-03 `report-generator.ts` — discarded Supabase `error` masked as COMPLETE

Same defect class as the `.in()`-filter / `chunkedRead.ts` silent-success bugs documented in
`src/jobs/agents.md` and `src/utils/jobPostcondition.ts` (the 70-hour anchoring outage lineage), found
here on a plain single-query read rather than a chunked one. `generateIntegritySummary`,
`generateCredentialAnalytics`, and `generateComplianceOverview` each destructured only `data` from a
Supabase query (`integrity_scores`, `anchors`, `audit_events` respectively) and discarded `error`.
postgrest-js **resolves**, never rejects, on a query-level error, so `generateReport()`'s try/catch
(lines ~98-171) never saw it — a transient DB read error produced zeroed/empty stats
(`distribution: {HIGH:0,...}`, `totalCredentials: 0`, `recentAuditEvents.total: 0`) and the report was
still persisted `status: 'COMPLETE'`. An org reading a failed integrity/compliance check would see
"everything is clean" instead of a failure.

Fix: check `error` at all three call sites and `throw` — this routes through the EXISTING
`generateReport()` catch block, which already marks the report `FAILED` with a real `error_message`.
No new helper added; this matches the file's own `default: throw new Error(...)` convention in the
report-type switch, so the file now has one consistent "generator function throws -> caller marks
FAILED" contract instead of two (throw for unknown type, silent-zero for a DB error).

**Deliberately out of scope, flagged not fixed:** `getReviewQueueStats` (`review-queue.ts`) and
`getExtractionAccuracy` (`feedback.ts`) — the two helper functions `generateComplianceOverview` and
the `extraction_accuracy` report branch call into — have the same discarded-`error`-then-return-empty
shape internally (`review-queue.ts` logs a warn per status and falls back to `count ?? 0`;
`feedback.ts` logs an error and returns `[]`). Each has exactly one OTHER production caller
(`api/v1/ai-review.ts`, `api/v1/ai-feedback.ts`) whose response contract would change if these started
throwing on a DB error — that's a wider, separate call worth its own review, not folded into this fix.

- `together.ts`'s `TogetherProvider.extractMetadata` did a naked `JSON.parse` on raw Together AI text output. `response_format: { type: 'json_object' }` (native JSON mode) suppresses markdown-fence wrapping but does not protect against truncated output hitting `max_tokens` mid-object — a `SyntaxError` there threw unhandled out of `extractMetadata`. Added a file-scoped `parseTogetherJson` (strip JS-style comments -> strip markdown fence -> brace-salvage/delimiter-repair), mirroring `gemini.ts`'s private `parseModelJson`. Kept file-scoped/independent per that precedent — do not extract a shared cross-provider module. Correction: an earlier version of this note (and the code comment above `parseTogetherJson`) claimed parity with a sibling `nessie-json-parse.ts` (`parseNessieJson`) as if it existed in this directory — it does not on this branch/main; it exists only on a separate, unmerged PR (#1660). Both the comment and this note now say so explicitly.
- `strip-json-comments.ts` remains the one genuinely shared helper across `gemini.ts`, `nessie.ts`, and `together.ts`; the fence-strip/brace-salvage/delimiter-repair logic is intentionally duplicated per-file rather than centralized.
- **xhigh code review found real correctness bugs in the initial cut, since fixed:** (1) the trailing-comma repair regex ran over the whole text with no string-boundary awareness and could silently strip a comma-then-bracket sequence occurring as ordinary prose inside a string field — replaced with a string-aware `stripTrailingCommasOutsideStrings`; (2) `balanceJsonDelimiters` never closed an unterminated string, so output truncated mid-string (a realistic `max_tokens` shape) was never salvaged — it now closes the open string (dropping a dangling incomplete escape first) before appending guessed structural closers; (3) `escapeBareNewlinesInStrings` escaped `\n`/`\r` but not literal tabs, so any string containing a raw tab threw `Bad control character` — tabs are now escaped too; (4) the salvage-path `JSON.parse` calls were unguarded, so a still-broken repair threw a fresh, less-diagnostic error instead of the original — `parseTogetherJson` now dedupes candidates and always surfaces the first parse error if every candidate fails. Not fixed (flagged, out of scope for this pass): mismatched-bracket-type repair, `finish_reason`-based truncation detection/retry, and the cross-file duplication itself (3-4 near-identical copies of this parser now exist in `gemini.ts`/`together.ts`/`eval/s33-wave1-prerequisite-runner.ts`/the unmerged nessie one) — a shared `model-json-parser.ts` module is a real candidate but is a design call for the CTO/RTE panel, not decided here.

## 2026-07-15 S3.3 Wave 2 Upstream 429 Attribution

- `gemini.ts` converts Gemini Developer API and Vertex regional HTTP failures into `AIProviderHttpError`, retaining only bounded status, `Retry-After`, API surface, model, region, prompt-version, schema-state, and MIME metadata. Provider bodies, prompts, response objects, credentials, and raw headers must never be retained, logged, thrown, or traced.
- `withRetry()` preserves those allowlisted fields across retry clones, generates one server-side UUID per provider invocation, and is the sole source of the explicit bounded attempt identity (`1..3`) passed to every upstream HTTP-error logger; 400/401/403/422 authentication or validation failures are non-retriable. `fallback-chain.ts` classifies 429 as `rate_limit` and 502/503/504 as `provider_unavailable`, and observer events expose only the bounded reason.
- Upstream attribution logs use `event=ai_upstream_http_error`, include `requestInstanceId` plus the retry-loop `attempt`, and inherit the client-controlled request correlation ID only as context. Release evidence groups by the server UUID, never by correlation ID or timestamp; observed attempts must be unique and strictly increasing, while sparse sets are valid because non-429 attempts are intentionally absent from the 429 artifact. Do not infer upstream counts from raw messages or sum them with client-side limiter buckets.

## 2026-05-22 Batch Embedding Review Hardening

- `embeddings.ts` rejects duplicate native batch `anchorId` values before provider calls or bulk upserts, and converts native credit pre-check failures into per-item `BatchReEmbedResult` errors.
- `gemini.ts` validates every `batchEmbedContents` vector as a finite 768-dimensional number array before returning embeddings.

## 2026-06-01 SCRUM-2190 Embedding Table Isolation

- `embeddings.ts` writes anchored credential vectors to `credential_embeddings` only. A low or zero row count there means few credentials have been embedded; it does not describe the separate public-record embedding pipeline.
- `public_record_embeddings` is populated independently by the public-records pipeline and must not be used as a fallback target for credential embedding writes.

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
| `gemini.ts` | Gemini Flash provider — primary production extraction plus privacy-bounded upstream HTTP attribution for Developer API and Vertex regional calls |
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
| `embeddings.ts` | 768-dim vector embedding service stored in `credential_embeddings`; uses provider-native batch embedding when available |
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
- **DO** prefer `IAIProvider.generateEmbeddings()` for bulk credential embeddings so Gemini requests are grouped through `batchEmbedContents` instead of per-credential fan-out.
