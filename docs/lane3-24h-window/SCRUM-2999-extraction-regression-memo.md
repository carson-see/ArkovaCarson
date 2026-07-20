# SCRUM-2999 — Extraction-Quality Regression: Root-Cause Memo + Sized Fix Plan

**Author:** Lane 3 (Credential Network & Intelligence), 24-hour train-protective window
**Date:** 2026-07-20
**Status:** Diagnosis complete. **No fixes land this window** (train-protective). Fix plan sized for post-train.
**Revision:** v2 — corrected after adversarial AI-engineer + DBA review. The v1 mechanism (model-SKU 404 + a template-discarding confidence gate) was **wrong**; the real mechanism is a **latency-budget breach → 100% fast-fallback** on the server extraction path, plus a large cohort-composition effect. Corrections noted inline.
**Evidence basis:** read-only prod queries (project `vzwyaatejekddvltxyye`), independently re-verified by two reviewers. Per §1.5 every claim is labeled measured / asserted / not-yet-verified.

---

## 1. Diagnosis fork — ANSWER

The founder's fork was: *thin in the DB → write-time regression; rich in the DB → display filtering.* The honest answer is **both a real server-side write-time degradation AND a large cohort-composition effect**, and the "April rich vs recent thin" framing is **partly a false comparison** — recent *interactive* user documents are **not** thin.

### Measured facts (all re-verified this window)

| Fact | MEASURED value |
|---|---|
| **April example ARK-DOC-JKYCVW** (2026-04-14) | 15 metadata keys = client-extracted template sections (`Invoice`, `Packing List`, `Import Permit`, `Gemological Certificate`, …) + 3 internal. |
| **Recent GENUINE (non-pipeline) docs** | Jul 13–16: `ARK-2026-14D7694B`=18 keys, `ZHSEN2`=13, `RUWEYX`=13, `TDR5B2`=9, `7HSSTZ`=9. **Not thin.** |
| **The thin outlier `ARK-DOC-GHZG6V`** (2026-07-20) | 4 internal keys only: `_ai_confidence:0.25`, `_review_reason:low_confidence`, `_claimed_at`, `_claimed_by:batch-1`. Batch-claimed, ran the **server** extraction path. |
| **Recent anchor VOLUME composition** | 499 of the 500 most-recent anchors are `pipeline_source` records (connector/public-record recovery: `source_url`/`record_type`, never templated). Hidden from the user's own-docs list by `src/hooks/useAnchors.ts:85` (`pipeline_source IS NULL`). |
| **Server extraction health** (`ai_usage_events`, last 40 days) | **100% `provider="fast-fallback"`, `error_message="provider latency budget was exceeded"`, `tokens_used=0`, avg confidence 0.31.** **Zero real Gemini extractions in 40 days.** |
| **Public projection** | `get_public_anchor('ARK-DOC-JKYCVW') -> 'metadata'` returns **`{}`** in prod — migration 0355's allow-list drops every template section from the *public* page (all rows, uniformly). |

### The real story (three effects)

**(R1 — the write-time root cause) The server extraction path is 100% falling to a heuristic fast-fallback because the primary Gemini call breaches the 4500 ms latency budget.** `ai_usage_events` proves it: for 40 days, every extraction logged `provider=fast-fallback` / "latency budget exceeded" / 0 tokens. The fast-fallback returns a fixed low-confidence heuristic (0.25 with no issuer, 0.35 with issuer — matching GHZG6V's 0.25 and the 40-day 0.31 average exactly). Any document that goes through the **server/batch** extraction path (e.g. GHZG6V, `_claimed_by:batch-1`) therefore gets near-empty metadata and is then flagged by `services/worker/src/jobs/anchor.ts:75-85` `revertToPending`, which stamps `_review_reason:low_confidence` + `_ai_confidence` when confidence < `ANCHOR_CONFIDENCE_THRESHOLD` (default **0.4**). This is the same failure mode as SCRUM-1993 (which hit the preview model), now recurring on GA `gemini-2.5-flash` — plausibly post-2026-06-17-sunset throttling, **but that needs a live latency check to confirm** (not verifiable this session; `gcloud run services list` returned empty under current access).

**(R2 — the dominant *visible* effect) Cohort composition.** Recent anchor volume is 499/500 connector/public-record **pipeline** records that structurally never run document template reconstruction. They dominate any raw recent scan and make "recent records" look thin — but they're a different, never-templated population, and the user's own-docs list filters them out. Much of the founder's "recent records are thin" is this, not extraction degradation.

**(R3 — public display, separate axis) Migration 0355** (SCRUM-2485, landed 2026-07-08) replaced the public-anchor base-`metadata` denylist with an explicit allow-list that drops template-section keys. Proven: the rich April record's public projection is now `{}`. This hides richness on the **public verification page** for all rows uniformly (so it is not itself an April-vs-recent asymmetry), and is a real second issue for the public view.

### Corrections to v1 of this memo (what was wrong)
- **v1 said the cause was model-SKU 404 drift (lite/distillation preview SKUs).** REFUTED: `extractMetadata`, `reconstructTemplate`, and vision all call GA `gemini-2.5-flash`; only `generateTags` uses the 404 lite SKU, and tags are fire-and-forget and **never persisted** to `anchors.metadata`. The 404s are real but not the cause. The real model problem is **latency/timeout, not 404**.
- **v1 attributed the low-confidence gate to `professional-education.ts:136` (0.85).** WRONG: that threshold only sets `requires_manual_review` on the `cpe/cle_metadata` columns and never writes `_review_reason`/discards a template. The actual gate is `anchor.ts:75-85` at default **0.4**. A fix aimed at 0.85 would touch dead code.
- **v1 blamed `maxOutputTokens=4096` truncation of `reconstructTemplate`.** REFUTED as a cause of thin stored rows: `reconstructTemplate` output is returned by an on-demand HTTP endpoint and is **never persisted** to `anchors.metadata`. The April template keys are **client-side** extraction fields, not reconstructTemplate output.
- **v1 overstated a broad write-time regression from n=1 (GHZG6V).** Representative recent non-pipeline docs are 9–18 keys. The degradation is real but scoped to the **server/batch** extraction path; interactive client-side extraction still works.

---

## 2. Sized fix plan (post-train; nothing lands this window)

| # | Fix | SCRUM | Size | Tier / owner | Notes |
|---|---|---|---|---|---|
| **1a (co-first)** | **Instrument + alert on the fast-fallback rate.** The definitive signal already exists: `ai_usage_events.provider='fast-fallback'` / "latency budget exceeded". Add a metric + alert on fast-fallback share and a backfill count since ~2026-06-17. Cheapest, fastest confirmation of any subsequent fix. | new 2999 sub-task | **S** (0.5d) | T1, Lane 3 in-lane | No schema change. Do this first — it proves 1b worked. |
| **1b (co-first)** | **Fix the server extraction latency breach.** Diagnose why `gemini-2.5-flash` extraction exceeds `AI_EXTRACTION_LATENCY_BUDGET_MS` (default 4500, unset in deploy) — post-sunset throttling / cold start / model degradation (needs a **live latency probe** first). Then either raise/tune the budget, or move generation to an eval-validated GA `gemini-3` that meets the budget. **Behind the intelligence-eval min-confidence gate.** | SCRUM-2909 / SCRUM-1951 | **M** + eval gate | **T2** AI behavior. **Split: the read-only live-latency verify = anyone/now; the deploy = RTE/Carson (prod deploy, `deploy-worker.yml`).** | Highest leverage: until real Gemini extractions return (tokens_used>0), everything else is cosmetic. **Do NOT** repoint lite/distillation SKUs as the fix — that's the wrong lever (they're off the persisted path). |
| **2** | **Reconsider the 0.4 revert-to-PENDING gate behavior.** When fast-fallback/low-confidence fires, `anchor.ts` reverts + stamps a stub. Decide whether to retain the (empty) fast-fallback result or hold for retry, so a transient latency blip doesn't strand a document as a thin stub. | SCRUM-2911-adjacent | **S–M** | T2, Lane 3/worker | Only meaningful after 1b; today the gate is correctly firing on genuinely-empty extractions. |
| **3** | **Reconcile 0355 allow-list with the public-display need** (R3). Template sections are reconstructed *document content* — **not** public by default per §1.6. If the owner's authenticated view should show the full template, add an authenticated, non-`anon` SECURITY DEFINER RPC (filtered on caller `user_id`/`org_id`) — **not** a change to the public `get_public_anchor`. | SCRUM-2485 follow-up / SCRUM-2914 | **M** + migration | **T3 — Lane 2 handoff** (migration touches `get_public_anchor` / `supabase/migrations/`; 0355 header marks it Lane 2). | DBA note: a new authenticated RPC is **not** gated by §1.8 (that freezes the *public* API only); owners already have raw-metadata SELECT via RLS. Needs Security & RLS Confluence update. |

**Do-first gate (read-only, no code):** confirm the live worker revision's env (`AI_EXTRACTION_LATENCY_BUDGET_MS`, `GEMINI_MODEL`) and run a live latency probe of the extraction call. Until that succeeds, 1b is scoped from `ai_usage_events` evidence, not from a confirmed live cause.

---

## 3. Ruled out
- **Not** primarily a display bug: the server path genuinely produces empty extractions (`tokens_used=0`), and GHZG6V is thin in the raw DB. (0355 is a real but *separate* public-view issue.)
- **Not** model-SKU 404 on the persisted path; **not** `maxOutputTokens` truncation; **not** the naked-`JSON.parse` bug (hardened 2026-06-24); **not** `ENABLE_AI_EXTRACTION` off (deploy asserts `=true`).
- **Not** a broad regression of interactive user uploads — those are 9–18 keys.

## 4. Evidence appendix (reproducible, read-only)
- Prod `vzwyaatejekddvltxyye`: `ai_usage_events` (40d) → 100% `fast-fallback`/"latency budget exceeded"/0 tokens; `anchors` key-count samples (JKYCVW=15, ARK-2026-14D7694B=18, ZHSEN2/RUWEYX=13, TDR5B2/7HSSTZ=9, GHZG6V=4); `get_public_anchor('ARK-DOC-JKYCVW')->'metadata'` = `{}`; 499/500 recent = `pipeline_source`.
- Code: `services/worker/src/api/v1/ai-extract.ts:27,68-78,237-268` (latency budget + fast-fallback), `services/worker/src/jobs/anchor.ts:75-85` (0.4 revert gate), `services/worker/src/ai/gemini.ts:456,761,819` (model routing: extraction/template/vision = `gemini-2.5-flash`, tags = lite), `gemini.ts:1269-1290` (brace-salvage parser, `04ea2bf2` 2026-06-24), `supabase/migrations/0355_*.sql` (public allow-list), `src/hooks/useAnchors.ts:85` (`pipeline_source` filter), `.github/workflows/deploy-worker.yml:270` (asserted prod env).

_Credit: v1→v2 correction driven by adversarial AI-engineer review (fast-fallback discovery in `ai_usage_events`) and DBA re-verification (cohort + 0355 public-drop proof)._
