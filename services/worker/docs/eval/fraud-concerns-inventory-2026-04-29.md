# SCRUM-1557: Fraud Concerns Surface Inventory (2026-04-29)

Repo grep against SCRUM-744 AC items. Source: feature branch `claude/dreamy-banzai-cbcad4`, base commit `02594dbc`.

## SCRUM-744 AC vs reality

| AC item | Status | Evidence | Gap |
|---|---|---|---|
| Structured fraud assessment in extraction output | **PARTIAL** | [services/worker/src/ai/fraudReasoning.ts](services/worker/src/ai/fraudReasoning.ts) — `FraudAssessment` type with `riskLevel`, `signals: string[]`, `reasoning`, `concerns: string[]`, `score` | `concerns` is `string[]`, not the structured `{concern_type, severity, specific_evidence}` shape SCRUM-744 AC specified |
| `fraud_concerns` API field | **MISSING** | Zero references to `fraud_concerns` / `fraudConcerns` in repo | Nothing exposes a structured `fraud_concerns` array on `/verify` or `/ai/extract`. Only the visual-fraud endpoint at [services/worker/src/api/v1/ai-fraud-visual.ts](services/worker/src/api/v1/ai-fraud-visual.ts) is wired |
| concern_type enum (formatting / issuer_mismatch / date_anomaly / template_deviation / missing_element) | **MISSING** | Zero references to `concern_type` / `concernType` | Need to lift `signals: string[]` into a structured enum; existing signal codes (`EXPIRED_ISSUER`, `JURISDICTION_MISMATCH`, `FORMAT_ANOMALY`, `MISSING_ACCREDITATION`, `SUSPICIOUS_DATES`) align loosely with the AC enum |
| severity (high / medium / low) per concern | **PARTIAL** | One reference in `services/worker/src/ai/gemini.test.ts:112` — `{signal: 'font_mismatch', severity: 'low'}` shape, but production `FraudAssessment.signals: string[]` doesn't carry severity | Per-signal severity is required; current code aggregates severity into the top-level `riskLevel` only |
| specific_evidence field per concern | **MISSING** | Zero references to `specific_evidence` / `specificEvidence` | `FraudAssessment.reasoning` is a single human-readable string covering all concerns; needs to split into per-concern evidence quotes |
| UI "Potential Concerns" section with severity badges | **PARTIAL** | [src/components/credentials/RiskAssessmentReport.tsx](src/components/credentials/RiskAssessmentReport.tsx) renders `riskLevel` + `RISK_COLORS` + concerns list | Component renders flat `concerns` strings, not severity-badged entries; section title is "Risk Assessment" not "Potential Concerns" (likely fine — confirm with copy |
| "No concerns identified" empty state | **NEEDS VERIFY** | RiskAssessmentReport.tsx renders something for empty `concerns[]`; need to check the exact string | UAT screenshot needed |
| Dismiss-with-reason flow | **MISSING** | Zero references to `dismiss.*concern` / `concern.*dismiss` / `fraud.*dismiss` in code or migrations | Not built. Needs a dismiss button + a `fraud_concern_dismissals` table or similar with admin user_id + reason |
| Persistence (fraud_signal_version + dismissal records) | **MISSING** | No migration matches `fraud` / `concern` in `supabase/migrations/` | Needs migration for tracking-improvements column or table |
| Latency budget +1s | **NEEDS BENCHMARK** | No latency test for the fraudReasoning post-extraction step | Add benchmark in eval suite |
| fraudSignals macro F1 ≥ 0.30 | **DRIFT (data)** | v5 eval JSON: TP=0 FP=3 FN=6 → F1=0.000 ([services/worker/docs/eval/eval-nessie_v5_fp16-2026-03-31T14-00-26.json](services/worker/docs/eval/eval-nessie_v5_fp16-2026-03-31T14-00-26.json)) | Tracked in SCRUM-1551 (data) + SCRUM-1558 (retrain) |

## API freeze check (CLAUDE.md §1.8)

`fraud_concerns` would be a new field on `/api/v1/verify` + `/api/v1/ai/extract`. Per CLAUDE.md §1.8: additive nullable fields are allowed without v2+. Schema change is safe so long as existing callers don't break.

## Plan implication for SCRUM-1558 (retrain) and SCRUM-744 close-out

1. Extend `FraudAssessment.concerns` from `string[]` to `ConcernEntry[]` with `{concern_type, severity, specific_evidence}` — keep backwards-compat by including a top-level `concerns_text: string[]` for older clients during a deprecation window.
2. Wire structured `fraud_concerns` field into `/verify` + `/ai/extract` API responses (additive nullable).
3. Update `RiskAssessmentReport.tsx` to render severity badges per concern.
4. Add migration for `fraud_concern_dismissals` table (admin user_id, concern hash, reason, dismissed_at, fraud_signal_version).
5. Add dismiss button + API endpoint.
6. Run latency benchmark in `services/worker/scripts/nessie-eval-regression.ts`.
7. SCRUM-1558 retrain on the SCRUM-1551 fraud-positive expanded golden — eval F1 ≥ 0.30.

## What this changes

The original SCRUM-744 drift comment described the model F1 gap. This inventory confirms the **API + UI surface gap is also real** — most of the fraud-concerns SHAPE was never built, only the underlying assessment module. So SCRUM-744 needs both data work (SCRUM-1551 + retrain) AND a small schema/UI lift, not just a retrain.

— Carson
