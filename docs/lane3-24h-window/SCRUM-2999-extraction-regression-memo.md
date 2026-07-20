# SCRUM-2999 — Extraction-Quality Regression: Root-Cause Memo + Sized Fix Plan

**Author:** Lane 3 (Credential Network & Intelligence), 24-hour train-protective window
**Date:** 2026-07-20
**Status:** Diagnosis complete. **No fixes land this window** (train-protective). Fix plan sized for post-train.
**Evidence basis:** read-only prod queries (project `vzwyaatejekddvltxyye`) + code archaeology of the extraction path (April→July). Per §1.5, every claim below is labeled measured / asserted / not-yet-verified.

---

## 1. Diagnosis fork — ANSWER: **write-time regression** (the raw DB is thin), with a compounding display-projection factor and a large cohort-composition effect.

The founder's fork was: *thin in the DB → write-time regression; rich in the DB → display filtering.* The DB is thin. Measured:

| Record | Anchored | Raw `anchors.metadata` keys (MEASURED in prod) |
|---|---|---|
| **ARK-DOC-JKYCVW** (founder's April example) | 2026-04-14 | **15 keys** — the reconstructTemplate section titles written as top-level keys: `Invoice`, `Packing List`, `Import Permit`, `Certificate of Origin`, `Customs Import Declaration`, `Gemological Certificate`, `Gemstone Details`, `Hallmark Certificate`, `Material Composition`, `Origin`, `Item Type`, `Estimated Value (USD)` + 3 internal (`_fee_sats`, `_metadata_hash`, `_raw_tx_hex`). No `extraction_method`/`extraction_confidence` key. |
| **ARK-DOC-GHZG6V** (most recent doc) | 2026-07-20 | **4 keys, all internal**: `_ai_confidence: 0.25`, `_review_reason: "low_confidence"`, `_claimed_at`, `_claimed_by: "batch-1"`. **Zero template sections.** The AI path *ran* and self-scored 0.25. |
| **ARK-DOC-* batch** (Jul 17) | 2026-07-17 | **9 keys, all pipeline internals**: `pipeline_source`, `record_type`, `source_id`, `source_url`, `_claimed_*`, `_recovered_*`. Connector/recovery records — never templated. |

Because the raw stored metadata is thin, this is **not** primarily a display-filtering problem. Display filtering (migration `0355`, below) is real and compounding, but it cannot be the root cause because the underlying rows themselves have no template data to project.

### The regression is three effects stacked, not one bug

**(E1) Cohort-composition shift — the largest visible contributor.** Recent anchor creation is dominated by connector/public-record **pipeline** records (`pipeline_source` set), which structurally never run document template reconstruction. `src/hooks/useAnchors.ts:85` filters `pipeline_source IS NULL`, so these are hidden from the user's own-documents list — but they dominate raw recent volume and make "recent records" look thin in any raw scan. This is consistent with the paused feeders / 259k pending-anchoring backlog. **Part of "recent records are thin" is that recent records are mostly a different, never-templated cohort — not that extraction degraded.**

**(E2) Write-time extraction failure on the records that DO run AI.** GHZG6V is the tell: the AI path executed, returned confidence 0.25, hit the low-confidence gate, and persisted **only** `_review_reason: low_confidence` with no template. In April there was no such gate, so even mediocre extractions wrote their sections. Two code mechanisms drive this:
  - **Model-SKU drift (SCRUM-2909).** Prod deploy config (`deploy-worker.yml`, ASSERTED) pins `GEMINI_MODEL=gemini-2.5-flash`; the in-code config note (`gemini-config.ts:13,21`) states 2.5-flash **sunsets 2026-06-17** and SCRUM-1951 owns the GA-gemini-3 upgrade that has not landed. Deploy config does **not** set `GEMINI_LITE_MODEL`/`GEMINI_DISTILLATION_MODEL`, so they fall back to code defaults `gemini-3-flash-lite-preview` / `gemini-3-flash-preview` — the sunset preview SKUs that memory + the `/ai/tags 404` note confirm return 40x in prod. The tag/classification and distillation sub-calls therefore fail, and the generation model itself is on a SKU flagged for sunset. Timeline correlates exactly with the April→July regression. *(Runtime env of the live worker revision was not confirmable this session — `gcloud run services list` returned empty under current access; the pin is asserted-from-deploy-config only. **Verify against the live rev before fixing.**)*
  - **Low-confidence gate converts degradation into blank records.** `professional-education.ts:136` `REVIEW_CONFIDENCE_THRESHOLD = 0.85` and `TemplateReviewPanel` `LOW_CONFIDENCE_THRESHOLD = 0.8` now gate output. When the (degraded/wrong-SKU/truncated) model returns low confidence, the template is withheld and only `_review_reason` is written — exactly GHZG6V's shape. This gate is *correct behavior on top of a broken model*; it makes the underlying model failure present as "thin record" rather than "wrong record."

**(E3) Output-shape + parse fragility over the same window (contributing / partially already fixed).**
  - `maxOutputTokens` caps (SCRUM-1281, landed 2026-04-29 — *after* the April-14 rich record): reconstructTemplate 4096, extractMetadata 2048. A rich multi-section customs/gemology document can truncate at 4096, dropping later sections.
  - Naked `JSON.parse` on fenced/truncated Gemini output (SCRUM-2601) — **already hardened 2026-06-24** (`04ea2bf2`, brace-salvage parser at `gemini.ts:1243-1287`). Before that fix, a truncated/fenced response threw and the whole template was dropped; after it, a partial object is salvaged (fewer sections than April). Net: this bug thinned records between its introduction and 2026-06-24 and is no longer a live cause, but explains part of the historical slope.

**(F) Display projection (compounding, not root).** Migration `0355` (SCRUM-2485, landed **2026-07-08**) replaced the public-anchor base-`metadata` denylist with an **explicit allow-list**. The allow-listed base keys are a fixed set (`title`, `credential_title`, `description`, `category`, `issuer`, `source_id`, `extraction_method`, `extraction_confidence`, `credential_id_hash`, …). The template-section keys (`Invoice`, `Packing List`, …) are **not** on the list — the migration comment explicitly says "any NEW anchors.metadata key … is dropped by default." So on the **public verification page**, even the rich April record's template sections are now hidden. This is a genuine second regression **for the public view specifically**, applied uniformly to all rows at read time (so it does not by itself produce April-vs-July asymmetry). If the founder's "April rich" observation came from an admin/raw view and "recent thin" from the same view, F is not implicated; if any comparison used the public page, F is hiding April's richness too and must be reconciled with the schema-freeze (§1.8).

---

## 2. Sized fix plan (post-train; nothing lands this window)

Ordered by leverage. Each item is independently shippable.

| # | Fix | SCRUM | Size | Risk / tier | Notes |
|---|---|---|---|---|---|
| **1** | **Verify + correct the extraction model SKU.** Confirm the live worker rev's `GEMINI_MODEL`/`GEMINI_LITE_MODEL`/`GEMINI_DISTILLATION_MODEL` against prod; move generation off any sunset SKU to an eval-validated GA gemini-3 (or confirm 2.5-flash is actually still served). Pin lite/distillation to a live GA SKU (`gemini-2.5-flash`) so `/ai/tags` and distillation stop 404-ing. | SCRUM-2909 / SCRUM-1951 / SCRUM-1573 | **M** (0.5–1d) + **eval gate** | **T2** (AI behavior). Must pass the intelligence-eval min-confidence gates before deploy. | Highest leverage: if the model is 404/degraded, every downstream fix is cosmetic. **Do this first and re-measure GHZG6V-class records.** |
| **2** | **Instrument the write-time drop.** Add a structured log/metric when a document runs extraction but persists no template (confidence-gated or parse-empty), tagged with model SKU + confidence + reason. Backfill a count of gated-empty records since 2026-06-17. | new sub-task under 2999 | **S** (0.5d) | T1 | Turns "records look thin" into a measured rate; validates fix #1's impact. No schema change. |
| **3** | **Raise reconstructTemplate `maxOutputTokens`** (4096 → e.g. 8192) or chunk multi-section templates, so rich customs/gemology docs stop truncating. Add a truncation detector (finish-reason check) that logs instead of silently salvaging a partial object. | SCRUM-1281 follow-up | **S–M** (0.5–1d) | T2 (AI cost + behavior) | Trade-off vs the SCRUM-1281 cost guardrail — size against current token spend. |
| **4** | **Reconcile the low-confidence gate with UX.** When gated, persist a review stub AND keep the raw extracted sections (behind a "needs review" flag) rather than discarding them, so a degraded-but-useful extraction is not thrown away. Surface via `TemplateReviewPanel`. | SCRUM-2911-adjacent | **M** (1d) | T2 | Prevents future model wobble from producing blank records; aligns with the review-panel that already exists. |
| **5** | **Reconcile `0355` allow-list with the public-display need.** Decide whether reconstructed template sections are public-displayable (they contain document content — likely **not** public by default per §1.6/§1.5). If they should show on the owner's authenticated view but not the public page, split the projection: keep `0355` public allow-list, add an authenticated owner view that returns the full template. Additive-nullable per §1.8; needs Security & RLS Confluence update. | SCRUM-2485 follow-up / SCRUM-2914 | **M** (1d) + migration | **T3** (migration + RLS + public projection) | Only needed if the founder's "rich" view was the public page. Confirm the observation surface first. |

**Do-first gate:** items 2 and 5's scoping both depend on **confirming which surface the founder compared** (raw/admin vs public page) and **the live model SKU**. Both are read-only checks; neither is a code change.

---

## 3. What is NOT the cause (ruled out)
- **Not** a pure display-filter bug: raw `anchors.metadata` is thin for recent AI-path records (GHZG6V measured at 4 internal keys).
- **Not** the naked-`JSON.parse` bug alone: hardened 2026-06-24; recent records are thin *after* that fix.
- **Not** `ENABLE_AI_EXTRACTION` being off: deploy config asserts `ENABLE_AI_EXTRACTION=true` (launch-required per §1.6).

---

## 4. Evidence appendix (reproducible, read-only)
- Prod, project `vzwyaatejekddvltxyye`: `SELECT public_id, jsonb_object_keys(metadata) …` for `ARK-DOC-JKYCVW` (15 template keys) and `ARK-DOC-GHZG6V` (`_ai_confidence:0.25`, `_review_reason:low_confidence`); Jul-17 batch (`pipeline_source` records).
- Code: `services/worker/src/ai/gemini-config.ts` (SKU pins + sunset note), `gemini.ts:520/703/769/824` (maxOutputTokens caps), `gemini.ts:1243-1287` (brace-salvage parser, `04ea2bf2` 2026-06-24), `services/worker/src/compliance/professional-education.ts:136` (0.85 gate), `supabase/migrations/0355_*.sql` (allow-list, 2026-07-08), `src/hooks/useAnchors.ts:85` (`pipeline_source` filter), `.github/workflows/deploy-worker.yml:270` (asserted prod env).
