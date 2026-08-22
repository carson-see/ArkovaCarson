# Bulk Upload + AI Extraction — Remediation Plan

**Date:** 2026-08-20 · **Author:** CTO session · **Status:** final, revised against adversarial review
**Prod:** `vzwyaatejekddvltxyye`, read-only (SELECT + EXPLAIN only). No writes, no PR mutation, no push to `main`, no rig touched.
**Bootstrap:** CLAUDE.md acked `d48a0118…` at 2026-08-20T22:27:34Z.

---

## 1. The 60-second brief

### 1.1 What is broken right now

Five things are broken. Four of them are broken *completely* — not slow, not flaky, returning zero successes.

| # | What is broken | How broken | Fastest fix | Expected impact |
|---|---|---|---|---|
| **1** | **API bulk upload dedup probe** does a full table scan of 3.55M rows | 100% failure — 5 of 5 authenticated POSTs in 30 days returned 503 at ~60s | Add `deleted_at IS NULL` to one query | Plan cost **1,776,181 → 2.03**, verified by EXPLAIN on prod. A timing-out endpoint becomes a millisecond lookup |
| **2** | **CSV extraction sends every row** into an endpoint capped at 50 | Every CSV over 50 rows fails deterministically (400/413) | Chunk at 50 — **but see §1.4, this one carries a live privacy defect** | CSV extraction works at all for the first time |
| **3** | **AI latency budget is set below the model's own median** | Budget 4,500 ms vs Gemini p50 5,806 ms → **zero successful AI extractions in June and July**; 25 of 26 calls fell back | Set `AI_EXTRACTION_LATENCY_BUDGET_MS=12000` — env var, no code | Extraction starts succeeding instead of timing out |
| **4** | **Anchor confidence gate blocks degraded extractions** | Fallback emits 0.25–0.35 against a 0.4 floor → anchors bounce to PENDING with a permanent false review marker | Set `ANCHOR_CONFIDENCE_THRESHOLD=0` — env var, no code | Extraction that succeeds is no longer blocked at the anchor step |
| **5** | **Public bulk RPC is granted to `anon` and `PUBLIC`** | Verified on prod: `bulk_create_anchors` has EXECUTE for `PUBLIC`, `anon`, `authenticated` | Revoke from both | Closes a grant far wider than its siblings |

**The single highest-impact fix: #1 — one predicate.** It is one line, it is verified against the real prod query planner, and it converts a fully-failing endpoint into a working one. Write it today; it enters a 12-hour T2 soak today and lands tomorrow. Nothing prod-affecting lands in an hour under §1.11/§1.12, and I am not going to pretend otherwise.

Fixes **3** and **4** are pure environment variables and need no code change at all — they are the fastest real relief on the extraction side.

### 1.2 Backfill throughput — today vs after the work

**This is the number that changed most under review, and it changed against us.**

| | 10,000 documents | 1,000,000 documents |
|---|---|---|
| **Today** | Fails outright | Fails outright |
| **After Track 1 + Track 3 as originally scoped** | ~15–40 min | **~50 hours to SECURED** (~2 h of that is ingest) |
| **After Track 3 + anchoring cadence work** | ~15–40 min | plausibly ~8–12 h — *unproven* |
| **Time to independently verifiable** | ~1.5 h | **~5 days after SECURED**, on top of the above |

Three corrections behind those numbers, all verified:

1. **Ingest was never the 1M bottleneck.** The anchoring cron `batch-anchors` runs `*/30 * * * *` (verified live via `gcloud scheduler jobs list`), fires exactly one Bitcoin transaction per invocation, and `BATCH_SIZE` is hard-clamped at 10,000 with the env override permitted to go **lower only**. That is a ceiling of 20,000 anchors/hour no matter how fast the database is. 1M documents = 100 batches × 30 min = **~50 hours**. Fixing ingest speeds up the 10k case and stops the failures; it does not move the 1M number at all.
2. **The earlier "~17 hours, or ~4–6 h with the chain fix" estimate was wrong** and is withdrawn. 4 hours would require a batch every 2.4 minutes — faster than the cron *and* faster than a Bitcoin block. Fixing the chain-funding defect (FD-CHAIN-1) is necessary but **not sufficient**; the cron cadence binds first.
3. **Proof materialization is a separate, longer wall.** Prod has 583,350 proofs against 3,553,500 anchors — 16.4% coverage. The only scheduled proof job fills 2,000 rows per 15 minutes (192,000/day), and the back-catalog materializer is deliberately unscheduled and operator-gated. A fresh 1M cohort needs ~5.2 days of proof fill *behind* the existing ~2.97M-row deficit. **"Anchored" and "verifiable" are two different dates and I will report them separately from now on.**

**Honest headline: "millions" is achievable. ~50 hours per million as the system is shaped today, ingest being about two hours of that. Getting under ~12 hours is a separate program of work — cadence, chain funding, and proof throughput — not a side effect of fixing bulk upload.**

### 1.3 What removing the confidence machinery costs

Mostly nothing, and it is the right call. Four real costs, all manageable:

1. **The last mandatory human checkpoint disappears.** `TemplateReviewPanel` does not merely show a badge — fields below its threshold *require* explicit acknowledgment or correction before the flow proceeds. Deleting the threshold without a replacement means a misread value (an 8-credit certificate read as 18) is auto-accepted and anchored immutably, and can flow into an auditor-facing compliance log. **Fix: re-base the gate on an objective trigger — missing required fields, empty or unparsable values — instead of deleting it.** Keep the review step.
2. **CLE/CPE records would flip to "requires manual review" forever.** Two normalizers force review whenever confidence is null. Dropping confidence makes that condition permanently true, so every professional-education credential would carry a banner saying its data is unreliable. Currently harmless — prod holds **zero** CLE and zero CPE anchors — but it is a live landmine on the licensure go-to-market surface.
3. **Two published contracts break unless edited first.** `confidence` is a **required** field in our published OpenAPI schema for `/ai/extract`, so any partner using generated client code would fail deserialization on every call. And our own migration guide currently tells partners to stay on v1 *specifically* to keep `confidence_scores`. Both need editing in the same change.
4. **We lose the only signal that would have caught this outage.** June and July produced zero successful extractions and nobody noticed for two months. **Replace it with two non-confidence alarms: fallback-provider rate, and missing-required-field rate per template.** Both objective, neither user-visible, neither a confidence score.

**One thing that is not a cost but needs a decision from you — see §1.4.**

### 1.4 Decisions needed from you

Four. The first two are genuinely yours; I have made every other call in this document myself.

**D-1. What does "recreates the template" mean?** There are two different products behind that phrase, and the plan deletes one of them.
- *(a) Layout reconstruction* — the existing `reconstructTemplate` returns the document's actual structure: headings, sections, labelled rows, a formal/compact/table style. It is live-wired today; we simply throw most of its output away.
- *(b) Field schema* — the 27 `credential_templates` rows, each a fixed list of fields for a credential type.

The current plan deletes (a) and builds on (b). If you meant (a), deleting it would remove the exact capability you named. **Default if you do not rule: keep (a), fold it into the single extraction call rather than deleting it.** This one materially changes the work.

**D-2. Do we accept customer-asserted fingerprints for backfill?** The million-document route has the customer hash their own documents and send us the fingerprint — no document ever reaches us, which is the cleanest possible position under §1.6. But it means **we never measured the fingerprint we are attesting to.** Today a proof package would look identical whether we computed the hash or the customer asserted it. **My recommendation: accept the route, but stamp provenance on every anchor (`measured_client` / `measured_connector` / `asserted_customer`) and say plainly in proof copy that a customer-asserted fingerprint is not an Arkova measurement.** That is a §1.5 evidence-honesty question, so it is yours, not mine.

**D-3. Does CLE/CPE manual review stay?** It may be a compliance commitment. Default if you do not rule: keep it, re-based on missing required fields rather than on a confidence number.

**D-4. Accept the ~50 h/million reality, or fund the cadence program?** Fixing bulk upload does not get us to "minutes". If a customer commitment needs faster, that is a separate T3 program (cron cadence + chain funding + proof throughput). Do not quote sub-50-hour numbers to anyone until that program has produced a measurement.

---

## 2. What adversarial review changed

Three independent reviews returned NEEDS_REVISION. I verified every blocking and major finding against prod and source rather than accepting them. **Nine survived verification and changed the plan; several were the difference between a fix and an incident.**

**Changed the plan materially:**

1. **T1.2 is no longer a one-line chunking fix — it is now the highest-risk item in Track 1.** Review caught that the 50-row cap currently failing every large CSV is *also* the only thing bounding a §1.6 breach. `buildRowText` serializes **every CSV column verbatim** — names, emails, bar numbers, whatever the customer uploaded — with no PII stripping, and the only importer of either stripper is the *document* path, not the CSV path. Chunking would have converted a deterministically-failing leak into a working one at scale. Worse, I confirmed the leak is **already live** for CSVs of 50 rows or fewer, which succeed today. The plan now ships stripping first, and treats it as a live compliance defect rather than a future risk.
2. **The 1M throughput estimate was wrong by ~3× and pointed at the wrong bottleneck.** The original "~17 h, or ~4–6 h with the chain fix" assumed 500–2,000 rows/s of ingest. Review pointed out our *own* evidence bounds ingest under 50 rows/s, and — decisively — that the `*/30` cron with a hard 10,000 batch ceiling caps anchoring at 20,000/hour regardless. Corrected to ~50 hours, and the framing corrected from "ingest is the problem" to "ingest was never the 1M problem."
3. **Index drops would have re-run the 2026-08-11 outage.** `DROP INDEX` is deliberately *not* covered by the hot-table lock-timeout linter (its own comment says so), and `DROP INDEX CONCURRENTLY` cannot run inside a transaction block — so the natural fix is to drop `CONCURRENTLY`, which takes ACCESS EXCLUSIVE on a 15 GB hot table and reproduces the exact FIFO lock-queue mechanism of the P0. The lint gap is now a prerequisite PR.
4. **A backfill would have starved every interactive user for two days.** The claim function is strict global FIFO with no per-org fairness, and the batch job explicitly passes `p_exclude_pipeline: false`, so a 1M backfill sits in front of every other tenant's single document. The originally-specified "per-org isolation check" soak would have *false-passed*, because there is no per-org isolation to check.
5. **Two published contracts would have broken silently.** `confidence` is `required` in our OpenAPI schema, and our own v2 migration guide tells partners to stay on v1 to keep `confidence_scores`. Both now edit in the same PR as the code.
6. **The accountability report would have printed a falsehood.** Writing `{}` for confidence makes `?? 0` render **"Overall Confidence: 0.0%"** in a PDF built for litigation discovery, next to a disclaimer asserting those scores reflect real model calibration. Asserting a measurement of zero is materially worse than omitting the field.
7. **The credit soak would have been vacuous.** `ENABLE_ORG_CREDIT_ENFORCEMENT` is unset on the prod worker and defaults false, so the entire charge/refund path is dead code. A soak proving "zero new debits" would have proved only that debits are switched off.
8. **Chaining unconfirmed transactions hits Bitcoin's 25-ancestor limit**, which our code classifies as a *definitive* rejection — triggering a full 10,000-anchor unwind that re-queues the same rows to fail again every 30 minutes.
9. **Rate limits were absent from every throughput number.** The §1.10 batch tier (10 req/min × 1,000 rows) puts a ~100-minute floor under 1M ingest, and the AI limiter (30/min) means a chunked 10,000-row CSV would have had ~85% of its chunks 429'd and *silently skipped* under the specified "skip failed chunks" rule.

**One finding I corrected in the other direction:** review argued the `/anchor/bulk` endpoint has no rate limiter. It has no *route* limiter, but a global tier limiter applies — it just grants the API-key tier (1,000/min) rather than §1.10's batch tier (10/min). Still a real divergence, still needs fixing, but not unlimited.

**One finding I contributed that no review caught:** the EXPLAIN for the fixed dedup probe selects **`idx_anchors_org_deleted_created`** — an index the plan lists as a *drop candidate* (178 MB, 45 lifetime scans). Dropping it would silently undo the headline fix. It is now protected.

**Accepted without change:** the soft-delete idempotency hole (prod has zero soft-deleted anchors — latent, documented, soak case added rather than code change).

---

## 3. Corrections to the diagnoses

Verified against prod and running config. These correct earlier analysis; each one would otherwise have caused wasted or no-op work.

### C-1. The two bulk paths have different root causes. Neither "one-line fix" fixes both.

Both relevant indexes are partial (`WHERE deleted_at IS NULL`). Verified matrix on prod:

| Path | Comparand emitted | `deleted_at IS NULL`? | Plan | Cost |
|---|---|---|---|---|
| `anchor-bulk.ts` dedup probe | `::bpchar` (auto-coerced) | **NO** | Parallel Seq Scan | **1,776,181** |
| same + `deleted_at IS NULL` | `::bpchar` | yes | Index Scan `idx_anchors_org_deleted_created` | **2.03** |
| `bulk_create_anchors` (declares `anchor_fingerprint text`) | cast on the **column** | **already present** | Seq Scan | ~1,797,903 |

An untyped SQL literal coerces to the column type automatically, so there is **no cast bug in `anchor-bulk.ts`** — its sole defect is the missing predicate. And `bulk_create_anchors` **already has** `deleted_at IS NULL` (verified in the live `pg_get_functiondef`) — its sole defect is the `text` declaration forcing a cast on the indexed column.

**Two distinct fixes in two distinct places. Applying either to the other path is a no-op that will look like a fix.**

### C-2. `batch_insert_anchors` is not broken — it is aborted client-side

The Sentry alert reports a *synthetic* `new Error(...)` built for telemetry, so the real error never reached Sentry. From Cloud Run logs, all sampled occurrences are `AbortError: This operation was aborted`. Cause: `BATCH_INSERT_RPC_TIMEOUT_MS = 20_000` against a function whose own `statement_timeout` is 120s, inserting `ANCHOR_INSERT_CHUNK = 1_000` rows into a table carrying **37 indexes / 7,822 MB against a 15 GB heap** (verified). The client gives up at 20s; the server statement keeps running while the serial fallback starts on the same rows. Compounding load, not a schema bug.

This matters because Track 3 routes user-facing bulk onto this RPC. It is the right primitive — it carries the 3.55M-row pipeline and already uses the correct comparand cast. It needs its deadline and chunk size aligned, and its error reporting made real.

### C-3. Prod scale (verified 2026-08-20)

`anchors` = **3,553,500** (3,553,498 SECURED, 2 REVOKED, **0 PENDING**, 0 soft-deleted) · `anchor_proofs` = **583,350** (16.4% coverage) · `extraction_manifests` = **54 rows across 22 distinct anchors** · `credential_templates` = **27** · `integrity_scores` = **0** · CLE anchors = **0** · CPE anchors = **0**.

Earlier "~2.97M anchors" and "~6,110 proofs" figures are stale — do not quote them.

### C-4. The Gemini 404 finding is REFUTED for prod

Verified on the live worker: `GEMINI_MODEL=gemini-2.5-flash`, `GEMINI_LITE_MODEL=gemini-2.5-flash` (env overrides the sunset preview default). **There is no live 404 and no config fix shippable on this axis.** The residual exposure is real but off the hot path: any rig standup that copies secrets but not `GEMINI_LITE_MODEL` inherits the sunset SKU. Fix the code default, not prod.

### C-5. Two failure knobs are env-overridable — no code change required

| Var | Code default | Prod | Effect |
|---|---|---|---|
| `AI_EXTRACTION_LATENCY_BUDGET_MS` | 4,500 | **UNSET** | Budget below the 5,806 ms Gemini p50 — timeout is the *normal* outcome |
| `ANCHOR_CONFIDENCE_THRESHOLD` | 0.4 | **UNSET** | Fallback emits 0.25/0.35, always below |
| `ENABLE_ORG_CREDIT_ENFORCEMENT` | `false` | **UNSET** | Entire credit charge/refund path is dead code in prod |

Also confirmed: `ENABLE_AI_FRAUD` env = `true` while the switchboard flag is `false`. Behavior honors the founder directive; the env var contradicts it and is one code change from going live.

### C-6. The 1,001/day duplicate-key errors are probably not the bulk RPC

A duplicate found by `bulk_create_anchors` is counted `skipped`, not `failed`. The 23505s are on direct PostgREST table inserts — a different path. **Unattributed, and not a basis for planning.**

---

## 4. Track 1 — stop the bleeding

### T1.1 — `anchor-bulk.ts`: add `deleted_at IS NULL` — T2

One predicate in `fetchExistingFingerprints`. Cost **1,776,181 → 2.03**, verified. Converts a 100%-failing endpoint into a millisecond lookup.

- **Soak:** a bulk POST from an org holding >1M anchors (severity scales with owned rows — this *passes on a fresh demo account and fails on a real one*); duplicate-heavy batch confirming duplicates return `skipped` and are not billed; confirm the 503 path no longer fires.
- **Protect the serving index.** The fixed probe plans onto `idx_anchors_org_deleted_created`, which §6 lists as a drop candidate. **Remove it from the drop list.** Dropping it would silently undo this fix.
- **Rollback:** revert one line.
- **Caveat, say it to the founder:** this fixes the *dedup probe*. The 1,000 serial single-row inserts after it remain — that is Track 3. Expect "works, still slow." Do not declare bulk fixed.

### T1.2 — CSV extraction: strip PII, then chunk — T2 · **revised, now two changes**

**Do not ship this as a chunking fix.** `buildRowText` serializes every column verbatim and POSTs it to the worker and on to Gemini. Both the component and the endpoint carry comments asserting "Only PII-stripped metadata arrives at this endpoint"; **nothing enforces it**, and the only importer of either stripper is the document path. The 50-row cap is currently the de facto containment — and it does not contain the small CSVs, which succeed today.

**T1.2a — stop the leak (ship first, independently):**
- Run every row through `stripPIIEnhanced` before building the payload, honoring its fail-closed `NERModelLoadError` behavior — a stripper failure aborts the upload rather than sending raw text.
- Restrict `buildRowText` to mapped columns plus user-confirmed template fields, not `columns.map` over all of them.
- Add a **server-side** rejection in `ai-extract-batch.ts` for rows matching email/SSN/phone patterns, so the boundary is enforced rather than asserted.
- Correct the two file headers that claim stripping already happens.
- **Soak assertion: zero rows reaching the provider match an email, SSN, or phone pattern.**

**T1.2b — chunk (only after T1.2a):**
- Chunk at 50 with concurrency **below** the 30/min AI limiter.
- **429 is retryable and must never be skipped.** Honor `Retry-After`. The originally-specified "skip failed chunks" rule would have silently dropped ~85% of a 10,000-row CSV and reported success — reproducing the 99.6%-`OTHER` signature we are trying to fix.
- Distinguish 429 (block-and-retry) from 4xx content failures (skippable).
- Surface a real ETA, not a progress bar that completes early.
- **Soak:** CSVs at 49/50/51/500/10,000 rows; a 10,000-row CSV yields extraction for 100% of rows **or** an explicit partial state naming un-extracted row indices. Zero silent drops.
- Even at 50 rows, 50 ÷ concurrency 3 × ~7 s ≈ 117 s against a 120 s client timeout — pair with T1.4 or raise the client timeout in the same PR.

### T1.3 — `express.json()` body limit — T2

`services/worker/src/index.ts:370` uses the body-parser default of **100 kb** while the bulk Zod cap is 1,000 rows (~121 B/row bare, ~250 B with metadata → 413 fires at ~409–846 rows, well before the documented limit). Set ~2 MB **scoped to the bulk/extract routes, not globally** — a global raise widens DoS surface.

- **Soak:** 1,000 rows at max field widths passes; a 10 MB body is still rejected; the anonymous 100 req/min limiter still absorbs scanner traffic.

### T1.4 — `AI_EXTRACTION_LATENCY_BUDGET_MS=12000` — T2, config-only

Budget 4,500 ms sits below the Gemini p50 of 5,806 ms, so timeout is the expected path: **zero successful AI extractions in June and July**; 25 of 26 calls fell back. 12,000 sits above p50 and below p95 (21,245 ms).

Ship **with** T1.5 or extraction succeeds and is then blocked at the anchor gate.

- **Governance:** applying this via `gcloud run services update` bypasses the PR tier machinery. Route it through `deploy-worker.yml` so the gate sees it.
- **Soak:** ≥50 real extractions; provider mix flips from ~92% fallback to majority `gemini`; watch p95 against the client abort; watch cost/extraction. **Run under concurrent cron load** — raising the budget holds a worker slot longer on a service that is already saturated (see §6.3), so this could *increase* 503s. Isolation would hide that.
- **Rollback:** unset. Instant, no code deploy.

### T1.5 — `ANCHOR_CONFIDENCE_THRESHOLD=0` — **T3**, config-only

Fallback emits 0.25–0.35 against a 0.4 floor, so every degraded extraction reverts its anchor to PENDING with `_review_reason: 'low_confidence'`. Measured: all 11 marked anchors still reached SECURED (avg 1.24 h) — so this is churn plus a **false and permanent audit marker**, which is a §1.5 evidence-honesty defect in its own right, not a permanent stall.

- **Tier: T3** — anchor lifecycle. The detector fails closed; do not argue it down because it is "just an env var."
- **Soak:** 48 h, Trigger A + B, daily flush, per-org isolation; no anchor blocked; no *new* `low_confidence` marker written.
- **This is a proof-integrity decision, not a config tweak.** It means degraded extractions anchor unconditionally — arguably correct under "read → recreate template → anchor", and it is the stated intent. I am making this call; flagging it as a call rather than a tweak.

### T1.6 — Align `BATCH_INSERT_RPC_TIMEOUT_MS`, cut chunk size, fix the telemetry — T3

Raise the 20s client abort to ≥120s (or lower `statement_timeout` to meet it) and drop `ANCHOR_INSERT_CHUNK` from 1,000 to ~250–500. Stops 1,206 silent degradations to serial insert and stops an aborted-but-still-running server statement contending with its own fallback.

- **Also in this PR: pass the real `rpcError`**, not a synthetic `new Error(...)`. The failure is currently undiagnosable from Sentry — I had to go to Cloud Run logs.
- **Constraint, do not leave this to the implementer:** surface the real error through the **message** path, which `scrubPiiFromEvent` scrubs, or through `boundedErrorDetail`. **Never attach a structured driver error to `extra`** — `event.extra` is filtered by key *name* only and `scrubString` is never applied to its values, so a 23505 on `(user_id, fingerprint)` would ship a document fingerprint to Sentry in breach of §1.1, repeating per failing chunk across a backfill.
- **Independent hardening:** make `scrubPiiFromEvent` run `scrubString` recursively over all string values in `extra` and `contexts`. Key-name filtering cannot cover arbitrarily-shaped driver errors and §1.1 is absolute. Add a regression test: a driver error carrying a 64-hex value in `details` emerges as `[FINGERPRINT]` regardless of which field it rides on.
- **Soak:** 48 h; the alert goes to zero; **measure real chunk insert latency — this is the number every 1M estimate depends on.**

### T1.7 — Gemini model code defaults — T1

`gemini-config.ts` defaults to sunset preview SKUs. Prod overrides them, so this is not a prod bug — but every rig standup that copies only secrets inherits a 404. Change defaults to `gemini-2.5-flash`.

- **Soak:** 2 h smoke on a rig with the env var deliberately unset.
- **Adjacent, do not bundle:** `gemini-2.5-flash` is documented in that same file as sunsetting 2026-06-17 — 64 days ago — and still serves. Stale pin, real future risk, own ticket.

### T1.8 — `ENABLE_AI_FRAUD=false` in prod env — T2

Aligns env with the switchboard flag (already false) and the standing directive. Behavior does not change today; removes a one-line-away regression.

### T1.9 — Revoke `bulk_create_anchors` from `PUBLIC` and `anon` — T3 (security)

Verified on prod: EXECUTE is granted to `PUBLIC`, `anon`, **and** `authenticated`, where the sibling `batch_insert_anchors` is `postgres` + `service_role` only. It self-authorizes via `auth.uid()` so it is not currently exploitable, but this is exactly the standing "REVOKE FROM PUBLIC is not enough" pattern — **both** the PUBLIC grant and the direct `anon` grant must go.

- **Soak:** RLS/grant tests; confirm the `authenticated` path is unaffected.

**Track 1 excludes** the `bulk_create_anchors` cast fix — it needs a migration, so it is T3 with a 48 h soak and cannot ship "today." It is the first item of Track 3. The browser bulk path has had **zero successful runs in 30 days**, so it is not regressing while it waits.

---

## 5. Track 2 — minimal extraction: read → recreate template → anchor

**Blocked on D-1.** If "recreate the template" means layout reconstruction, §5.3's deletion of `reconstructTemplate` is wrong and it should be folded into the single call instead. Everything else in this track stands either way.

### 5.1 The output contract

Replace the 40+-key union with a two-part contract resolved per document:

```jsonc
{
  "credentialType": "CLE",            // enum; drives template resolution
  "issuerName": "…",                  // → written to metadata.issuer (see 5.2)
  "issuedDate": "2026-05-01",         // → anchors.issued_at   COLUMN
  "expiryDate": "2027-05-01",         // → anchors.expires_at  COLUMN
  "jurisdiction": "CA",               // optional
  "templateFields": {                 // ← the "recreate the template" payload
    "course_title": "…",
    "credit_hours": 3
  }
}
```

No `confidence`, no `confidenceReasoning`, no `reasoning`, no `concerns`, no `fraudSignals`, no per-field confidence.

**`templateFields` MUST be flattened into `anchors.metadata` at write time.** Two consumers read these keys **flat**: the CLE/CPE normalizers read `fields.credit_hours ?? fields.creditHours` and `fields.ethics_hours ?? fields.ethicsHours`, and the CTDL serializer reads `metadata[key]` flat to derive `ceterms:creditValue` — the exact field Credential Engine personally corrected us on. Nesting without flattening silently omits the CE-facing credit value and permanently forces CLE manual review. Add regression tests pinning `ceterms:creditValue` presence and both credit-hour spellings.

**Prompt:** ~4 fixed fields + ~6 resolved template fields + the type enum, against today's ~126,000-character system prompt sent on every call — roughly a **16× input reduction**, the single largest latency lever available.

### 5.2 Three defects that make "recreate the template" a no-op today

1. **Template key matching has no normalization.** Across the 25 system templates, 18 field slots use snake_case the extractor never emits (`course_title`, `credit_hours`, `bar_number`, `ethics_hours_completed`). For the entire CLE/CPE family, every required field reports `missingRequired` and every extracted field lands in `unmappedFields` — **template mapping is silently 0% effective there.**
2. **`gemini.ts` hardcodes the full system prompt in the untuned path.** The slim v6 prompt is selected only inside `if (this.tunedModelPath)`, and `GEMINI_TUNED_MODEL` is unset in prod. **Setting `GEMINI_V6_PROMPT=true` today would change nothing.** The untuned path must honor the computed prompt.
3. **The public projection reads `metadata->>'issuer'` while the extractor writes `issuerName`** — so the public issuer name has never come from AI extraction; it falls through to `organizations.display_name`.

**Correction to the earlier claim that prompt-keying makes mismatch "structurally impossible":** verified on prod, `default_metadata.fields` has **two incompatible shapes** — 22 system types store an **array** of `{key,label,type}` with camelCase keys the extractor already emits; the 3 CLE rows store an **object map** with snake_case keys. So the 0%-effective finding is real but scoped to the object-shaped rows; the array-shaped rows already map and cover the overwhelming majority of anchors. Additionally there are **2 customer-authored templates, one with `default_metadata = '{}'`** — no field schema at all.

Therefore: **keep the normalization layer** (prompt-keying alone does not remove the mismatch), **support both shapes**, and **specify the fallback** when a resolved template has no parsable field schema — fall back to the `OTHER` array schema rather than sending a prompt with no template fields, which would render a customer's own template blank. Add a test iterating every `credential_templates` row asserting a non-empty resolved field list.

### 5.3 Removed

| Removed | Note |
|---|---|
| Fraud few-shots (12,065 chars) + `fraudSignals` demand | demanded unconditionally regardless of `ENABLE_AI_FRAUD` |
| 12 of 13 per-type guidance blocks (~26k chars) | send only the resolved type's block |
| Confidence calibration guidance | `confidence` appears 166×, `fraud` 204× |
| `calibrateConfidenceByProvider`, `computeAdjustedConfidence` | |
| `runEnsembleExtraction` / `extractWithEnsemble` | **3× cost, zero callers** |
| `enqueueTagGeneration` | 3rd Gemini call, fire-and-forget, uncapped — fold `tags` into the single extraction |
| `useExtractionFeedback`, `IntegrityDetailView` | no non-test importers / no importers at all |
| `extraction_feedback`, `institution_ground_truth` | 0 rows each |
| `/api/v1/ai/template` + `reconstructTemplate` | **HELD pending D-1** — this is the layout-reconstruction feature |

**`integrity_scores` removed from the drop list.** It is empty (verified 0 rows) because `/api/v1/ai/integrity` sits behind `aiFraudGate()` and fraud is off by directive — **not** because it was evaluated and rejected. It is also the only code computing a non-fraud "was this extraction any good" signal, which is exactly what §5.6 item 4 needs a home for. Dropping it converts a one-line flag decision into a schema rebuild and 404s two documented endpoints. **Keep it; revisit once the replacement quality signal has a design.**

Net (excluding the held item): **three LLM round trips per document collapse to one**, carrying ~1/16 the input.

### 5.4 Sequencing — this is what breaks production if done backwards

**Remove every consumer before removing the producer.** If `confidence` disappears while the gates remain, `undefined >= 0.5` is `false` and **every document becomes `credential_type: 'OTHER'` with zero auto-accepted fields** — today's degraded regime made permanent. (Corroborating: July 2026 was 99.6% `OTHER`, 2,515/2,525 — the same month with zero successful extractions.)

1. `anchor.ts` gate → `ANCHOR_CONFIDENCE_THRESHOLD=0` (T1.5, already in Track 1), then delete the block.
2. `SecureDocumentDialog` — `detectedType` takes the model's value unconditionally.
3. `SecureDocumentDialog` — auto-accept mapped fields.
4. **`TemplateReviewPanel` — re-base, do not delete.** Its threshold is not a badge trigger; per the file's own header, flagged fields *require* acknowledgment or correction before the flow proceeds. It is the last mandatory human checkpoint before immutable anchoring, and steps 2–3 already remove every other one. **Replace the confidence trigger with an objective one — `missingRequired` plus empty/unparsable value — in the same PR that removes the threshold.** Deleting outright contradicts §5.6 item 1's own "keep the review step."
5. **`compliance/professional-education.ts` — re-base both normalizers.** They force `requires_manual_review` when confidence is null, so dropping confidence pins it true forever. **Also update `cpe-extraction-prompt.ts`**, a *second* extraction prompt that instructs the model on the 0.85 threshold and was missing from the earlier inventory. Re-base on missing required fields; the CLE normalizer already has an independent `ethics_hours` trigger to model on. Mitigating fact: prod has **0 CLE and 0 CPE anchors**, so this is a forward regression on the licensure surface, not a live customer break.
6. **`ai-accountability-report.ts` — fix before §5.5 lands.** It renders `(confidence_scores?.overall ?? 0) * 100`, so `{}` prints **"Overall Confidence: 0.0%"** in a PDF built for litigation discovery and regulatory audit, beside a disclaimer asserting the scores reflect model calibration. **Remove the Overall Confidence and Grounding Score rows and the confidence disclaimer entirely when the value is null or empty — never `?? 0`, never an "N/A" row implying the measurement exists.** Confirm the two pass-through endpoints (`ai-provenance`, `anchor-extraction-manifest`) stay safe.
7. `api/v1/ai-template.ts` — `confidence` is a required request field; it dies with the endpoint (**held pending D-1**).
8. **Publish the OpenAPI change before the code change.** `confidence` is in `required: [fields, confidence, provider]` for `/ai/extract`. Any partner using generated client code rejects a payload without it — a total integration outage with nothing in our logs. Either keep it as a documented constant or move it out of `required` and mark it nullable, then publish. Our own SDKs type it optional, so first-party testing will **not** catch this.
9. Only now: drop `confidence` from model output and prompt.

### 5.5 Compat for existing rows

`/api/v1/verify` is a frozen §1.8 schema. `confidence_scores` is published, sourced from the latest `extraction_manifests` row, and all 54 manifests carry it.

**Do not delete it. Emit `null` always.** It is already typed nullable and already returns `null` on the no-manifest path, so null-always is contract-compatible and needs no v2 and no 12-month deprecation.

- Existing 54 rows (across 22 anchors): leave in place. Do not backfill, do not delete — historical evidence.
- `extraction_manifests.confidence_scores` is `NOT NULL`: keep the column, write `'{}'::jsonb`. Dropping `NOT NULL` is a migration for no benefit. **Contingent on §5.4 step 6 landing first**, or `{}` becomes "0.0%" in the audit PDF.
- New manifests keep `model_id` + `prompt_version`, so the regime change is auditable per row.

**Land the documentation edits in the same PR, not as follow-up.** We published a migration guide telling partners to stay on v1 *specifically* for `confidence_scores`, and the promise is repeated across the API README, API guide, both SDK READMEs, and the technical wiki. Leaving those in place while the field returns null is precisely the §1.13 R-7 pattern — a public claim of a capability we no longer deliver. Blast radius is genuinely tiny (54 manifests, 22 anchors of 3.55M), and that is the argument to make.

### 5.6 What the founder's goal costs, stated plainly

1. **Type detection loses its only quality signal.** A wrong `credentialType` now silently selects the wrong template. Mitigation: closed enum, and the user sees the template on the review screen before confirming. **Keep the review step — do not auto-confirm.**
2. **CLE/CPE manual-review trigger disappears** unless re-based (§5.4 step 5). See D-3.
3. **`/verify` consumers reading `confidence_scores` see null.** Contract-legal; tell any partner parsing it.
4. **No quality signal survives anywhere.** Today confidence at least *correlates* with degradation (0.815 gemini vs 0.325 fallback). Replace it or the first silent regression goes unnoticed for months exactly as this one did. **Proposed: alert on fallback-provider rate and on `missingRequired` rate per template** — objective, not user-visible, not a confidence score. `integrity_scores` is the natural home (§5.3).
5. **EU AI Act Art. 13 transparency.** Our launch-readiness register records this control as satisfied by "AI suggestions show confidence scores." That evidence is already stale and Track 2 makes it structurally nil. **Surface model id and version — not a score — on the review panel, and update the register row in the same PR.** One copy string plus one field, and it satisfies Art. 13 strictly better than the thing being removed.

**Tier:** prompt + gate changes **T2**; table drops **T3**; `/verify` null-always **T2**.
**Soak:** ≥200 extractions across ≥10 credential types; provider mix majority `gemini`; `missingRequired` rate per template at or below baseline; **zero `OTHER` inflation vs baseline**; p50 under the new budget; token cost down ~10×.
**Rollback:** prompt and gates revert as code. Table drops need a compensating migration — they are 0-row tables, so schema-only with no data loss. **Sequence drops last, after the prompt has soaked.**

---

## 6. Track 3 — backfill-scale throughput

### 6.1 Routing, and the constitutional boundary per route

Say this to the founder directly: **§1.6 and "OCR a million documents interactively in a browser" are mutually exclusive.** Client-side OCR is 20–180 s/document for scanned files and is serialized, with a designed 180 s per-document ceiling. A tab will never do thousands of OCR'd documents. That is physics, not a bug.

| Route | Documents | Boundary | Extraction | Ceiling |
|---|---|---|---|---|
| **A. Browser, hash-only** | user's device | **§1.6** — bytes never leave | none | low thousands/session |
| **B. Connector** (DocuSign/Drive) | third-party cloud | **§1.6A** — fetch → SHA-256 → discard | **none pending amendment** | high |
| **C. Signed batch-ingest API** | **customer's own infra hashes** | §1.6 data rule still binds (below) | none by default | millions |

**Route C is not constitutionally exempt.** Earlier framing said "no document ever reaches us, so neither §1.6 nor §1.6A applies." §1.6's operative *data* rule is "Only PII-stripped structured metadata + fingerprint may flow to server" — a constraint on **what we ingest**, not merely on how it was produced. Route C ingests arbitrary customer-supplied structured fields at million-row scale. Therefore:
- **Mandatory server-side scrub** of every ingested field through `scrubString`, plus an **allowlist restricted to the resolved template's field keys** — reject unknown keys rather than storing them. Otherwise a customer backfilling HR records puts national IDs and salary bands into `anchors.metadata` and onto the public projection surface.
- **`fingerprint_provenance` column** (`measured_client` | `measured_connector` | `asserted_customer`) written at ingest, surfaced in `/verify` as an additive nullable field (§1.8-legal), with proof copy stating a customer-asserted fingerprint is **not** an Arkova measurement. Without it a Route C anchor is indistinguishable from one where we computed the hash from real bytes. **This is D-2.**

**Route B extraction is struck pending a CLAUDE.md amendment.** §1.6A authorizes server-side *fingerprinting* and then constrains the output to "the fingerprint + bounded, PII-scrubbed metadata." Sending connector bytes to a third-party model is neither. The carve-out is void-unless-ALL and requires discard after hashing, so post-anchor extraction would structurally require retaining or re-fetching the bytes. The SCRUM-2492 lint forbids passing bytes to loggers/Sentry/Error — **not** to an outbound HTTP client. If we want this, amend §1.6A explicitly first, name the provider, forbid provider-side retention, and extend the lint. Do not resolve it inside a remediation design.

**Named non-goal:** *post-anchor enrichment applies to Routes B and C only. Route A anchors are permanently un-enrichable by construction, because §1.6 means the document does not exist server-side at any point. Any future proposal to enrich a Route A anchor requires re-processing on the user's device, never server-side retention.* This is stated explicitly so a later sprint cannot satisfy "opt-in enrichment" by introducing a short-lived server-side document buffer — the raw-mode bypass §1.6 forecloses.

**Backfill is extraction-free by default.** Running Gemini over a million historical documents is neither affordable nor necessary, and client-side OCR is unavailable on this path anyway. Extraction becomes a separately-queued, opt-in enrichment over already-anchored rows — never a precondition for anchoring.

### 6.2 The ingest pipeline

1. **`bulk_create_anchors`** — declare `anchor_fingerprint character(64)` (or cast the comparand) to kill the seq scan, then replace the per-row loop. Verified on the live definition: it does a per-row `SELECT` + per-row `INSERT` each in its own subtransaction, accumulates results in **O(N²)** byte-copying, swallows every real error as the constant `'insert_failed'` (which is why bulk upload has no failure telemetry anywhere), and takes `pg_advisory_xact_lock` on `auth.uid()` — **permanently capping a single user's concurrency at 1**.
2. **`anchor-bulk.ts`** — replace 1,000 sequential `.insert().select().single()` calls with one `batch_insert_anchors` call.
3. Both route to `batch_insert_anchors` (`INSERT … SELECT … ON CONFLICT DO NOTHING`), which is `service_role`-only — so the browser path goes **through the worker**, putting bulk behind the rate limiter, credit ledger, and real logging.

**Tenancy must be re-established at the worker boundary.** `batch_insert_anchors` is SECURITY DEFINER and takes `user_id`/`org_id` **verbatim from the payload** with no `auth.uid()` derivation — unlike `bulk_create_anchors`, which self-authorizes. Service_role bypasses RLS, so a forwarded client-supplied `org_id` writes anchors into another tenant's org with nothing downstream to catch it. **Server-side derivation from the authenticated session is a named requirement of this migration**, plus a cross-tenant attempt in the T3 grant tests.

**Removing the advisory lock creates a concurrent double-charge** unless the debit moves. Two concurrent same-user batches containing the same new fingerprint both see it as new and both debit; `ON CONFLICT DO NOTHING` protects the row, not the charge. **Drive the debit from the RPC's actual insert result** (it already returns the inserted/existing split), or charge per-anchor at SECURING. Soak: two concurrent same-user batches with overlapping fingerprints, asserting debits == rows actually created.

**Index diet — prerequisite, with two corrections.** 37 indexes / 7,822 MB against a 15 GB heap (verified) is what makes a 1,000-row insert exceed 20 s.

| Index | Size | Lifetime scans | Disposition |
|---|---|---|---|
| `idx_anchors_filename_trgm` | 2,726 MB | 104 | drop candidate — **verify the search surface first** |
| `idx_anchors_description_trgm` | 1,133 MB | 97 | drop candidate — same |
| `idx_anchors_backfill_desc` | 243 MB | **0** | drop candidate |
| `idx_anchors_user_status_created` | 226 MB | **0** | drop candidate |
| `idx_anchors_org_status_created` | 217 MB | 60 | drop candidate |
| `idx_anchors_org_deleted_created` | 178 MB | 45 | **KEEP — serves the fixed T1.1 probe** |
| `idx_anchors_user_created_desc` | 178 MB | 4 | drop candidate |
| `idx_anchors_fingerprint_lookup` | 429 MB | 12,626,258 | **KEEP** |
| `idx_anchors_user_fingerprint_unique` | 515 MB | 12,550,646 | **KEEP** |

**Correction 1:** `idx_anchors_org_deleted_created` is removed from the drop list — the EXPLAIN for the fixed dedup probe plans onto it. Dropping it undoes T1.1.
**Correction 2 (blocking):** **every index drop is DDL on a §1.2 hot table**, and `DROP INDEX` is deliberately *not* covered by `check-hot-table-ddl-lock-timeout.ts` — its own comment says so, because the linter matches table identifiers and the statement names the index. Meanwhile `DROP INDEX CONCURRENTLY` **cannot run inside a transaction block**, which is how migration files run, so the natural unblock is to remove `CONCURRENTLY` — silently converting it into an ACCESS EXCLUSIVE lock on a 15 GB hot table and reproducing the 2026-08-11 P0's FIFO-barrier mechanism exactly. Therefore:
- Add the missing `DROP INDEX` pattern to the linter (index→table map, or a required `-- HOT TABLE: anchors` annotation) **as its own PR, before the diet lands**.
- Use a session-level `SET lock_timeout = '5s';` at the top of each non-transactional migration file (`SET LOCAL` is unusable outside a transaction), or run the drops as operator-executed MCP DDL under the same session guard — which §1.2 designates knowingly-unenforceable and on the operator.
- One drop per migration, rehearsed on an isolated rig **under concurrent read load**, not just for plan regression. Trigram indexes back user-facing filename/description search — **enumerate that surface before dropping**, or the fix breaks a feature.

### 6.3 Fairness, queue, backpressure, idempotency, observability

**Fairness — must land before any backfill route ships.** Verified: `claim_pending_anchors` is strict **global FIFO** (`ORDER BY created_at ASC`), with no weighting, no round-robin, and no per-tenant cap; and `batch-anchor.ts` explicitly passes **`p_exclude_pipeline: false`**, so even the existing pipeline-exclusion lever is switched off. A 1M backfill therefore sits in front of every other tenant's next document: at 10,000 per 30-minute invocation, an interactive user's single document is not claimed for ~50 hours. **The product visibly stalls for the entire tenant base for two days.**

The lever already exists and is one parameter away: tag backfill rows (`pipeline_source`), pass `p_exclude_pipeline: true` on the interactive lane, and drain backfill on a separate lower-priority lane. `idx_anchors_pipeline_status` (18,672 scans) already supports it. Alternatively a per-org share cap inside the claim.

**Correct the soak spec:** the originally-required "per-org isolation check" would **false-pass**, because there is no per-org isolation to check. Replace it with an explicit interactive-latency assertion under backfill load.

**Claim plan at scale is unvalidated, and its timeout is a silent no-op.** With PENDING = 0 today the planner takes a status-only index plus an explicit Sort. At 1M PENDING it may have to sort ~1M rows; the claim is wrapped in a 30s client timeout whose catch does `return emptyResult()` when nothing was claimed — **indistinguishable from an empty queue.** The pipeline would stop draining for all tenants at exactly the moment the backfill lands, presenting as a silent no-op. **Before any backfill ships: EXPLAIN ANALYZE the claim at 10k/100k/1M on an isolated rig, confirm `idx_anchors_pending_claim` is selected (add the `pipeline_source` predicate to it or drop that filter from the claim), and change the timeout path from `emptyResult()` to an alerting failure.**

**Queue.** `job_queue` holds 25 rows all-time with **no upload/import/extraction job type at all**. Bulk upload is not queue-backed: it runs synchronously in an HTTP request or in the browser, and the wizard literally says "Please do not close this window." A failed bulk upload leaves **zero durable server-side trace** — which is why this was invisible for months. Design: ingest writes a durable `backfill_batch` + `backfill_item` pair, returns a batch id immediately (202), drains asynchronously, resumes by batch id. Nothing depends on a browser tab staying open. Use `connector-artifact-drain.ts` as the skeleton — it has the right properties (compare-and-set claim, idempotent debit keyed on anchor id, Zod-`.strict()` insert pinned to `PENDING` so an importer can never fabricate a SECURED anchor, bounded error detail) — but it has run **17 rows**. It is unproven past toy volume and must be load-proved, not assumed.

**Rate limits are a hard input, not an afterthought.** §1.10's batch tier is implemented: 10 req/min on the self-service bulk route, with a 1,000-row Zod cap — a **10,000 rows/min ceiling, i.e. a ~100-minute floor for 1M ingest** regardless of database speed. Any estimate faster than that is forbidden by our own constitution. **The correct lever is rows-per-request, not requests-per-minute** — raising rows/request stays inside §1.10; raising req/min is a CLAUDE.md change and goes through PR review as a constitution change, not an implicit assumption in a design doc. Separately, `/api/v1/anchor/bulk` (API-key path) carries **no route limiter** — it falls through to the 1,000/min API-key tier rather than the 10/min batch tier. **Add an explicit batch-tier limiter there before T1.1 removes the 503 that is currently acting as an accidental brake.**

**Backpressure.** Accept-and-queue, never block. Bound the drain by in-flight chunks; shed with 429 + `Retry-After` beyond a queue-depth watermark. The worker is 2 CPU / max 10 instances and **already saturated** — `/jobs/fetch-courtlistener` is 72.6% 504 over 2,895 invocations, every failure at the 3,600 s ceiling, scheduled every 15 min while running 60+ min, so **four invocations overlap at all times**. **Throttling or fixing that job is a prerequisite for trusting any backfill throughput number**, and it is arguably the highest-value non-bulk fix in this document.

**Idempotency.**
- Natural key `(user_id, fingerprint) WHERE deleted_at IS NULL` is already the unique index and the `ON CONFLICT` target. **Caveat, now stated rather than claimed away:** both the conflict arbiter and the existence probe filter `deleted_at IS NULL`, so a **soft-deleted row is invisible to both** — soft-delete-then-reingest creates a duplicate anchor and a second charge. Latent today (prod has **0** soft-deleted anchors) but one product decision from live. Document it and add the soak case; the specified "re-run a batch, prove zero new anchors" test passes while the hole is open.
- **Resolve the ingest-vs-SECURING contradiction.** §6.3 says "charge at SECURING, never at ingest", but `anchor-bulk.ts` charges at ingest with the caller's `batch_id` as the idempotency reference and the post-dedup count as the amount. A partial retry with the same batch_id then hits an amount mismatch → `idempotency_key_conflict` → HTTP 402, and **those rows can never be ingested under that batch id**; changing the id charges again. Move the charge to SECURING via the anchor-keyed mechanism, or make the ingest debit per-anchor-keyed. **Do not ship the recommended caller-supplied `batch_id` retry pattern until this is fixed** — it standardizes the exact input that trips the conflict. Also: `batch_id` is `z.string().min(1).max(100)` while the reference parameter is `uuid`, so a non-UUID value errors out. Type it `uuid` or stop passing it as the reference.
- **Retry after a refund creates free anchors.** Refunds are append-only — the DEBIT row survives — and the replay check keys on that row, so every later charge for the same reference returns `deducted: 0`. An anchor that went charge → refund → re-claim → SECURED is charged nothing. Make the reference attempt-scoped, and soak-assert exactly one net DEBIT across that path.
- **Every credit property above is currently untestable in a default rig.** `ENABLE_ORG_CREDIT_ENFORCEMENT` defaults false and is **unset on the prod worker** (verified), so the whole charge/refund saga is dead code. **A credit soak with the flag unset is not weak evidence — it is no evidence.** Require the flag explicitly set on the rig, and make it a field in the soak block.
- **Bound the refund fan-out.** It currently does `Promise.all` over up to 10,000 concurrent refund RPCs, each taking `SELECT … FOR UPDATE` on the **same single `org_credits` row** — a thundering herd on one row lock, from a 2 CPU container, fired exactly when the system is already failing. Bound to ~10–20 concurrent. Independently: because every debit locks that same per-tenant row, credit accounting for a single-tenant 1M backfill is **strictly serial** — roughly 50 minutes of unavoidable serialization at ~3 ms per lock-and-commit, on the row the interactive balance display reads. Batch credit operations per chunk (one debit of N) or move to an append-only ledger with a derived balance. This is currently invisible in the throughput model.

**Observability.** Minimum bar: per-batch durable status (`queued/draining/done/failed` + counts); real error text on `backfill_item` (bounded, PII-scrubbed, never raw bytes); a fallback-provider-rate alert; a queue-depth/age dead-man. **Also fix the DLQ:** `webhook_dead_letter_queue` inserts fail with 42P10 (`ON CONFLICT` naming a non-existent constraint) **617×/day**, so its 0 rows mean "the dead-letter path is broken," not "nothing dead-letters."

### 6.4 Wall-clock — recomputed

**Every figure below is an engineering estimate except where marked measured. The one number that would make them measurements — sustained rows/sec post-index-diet — requires a write and is out of scope here. Do not put these in a customer commitment until T1.6's soak produces the real figure.**

**Ingest rate.** The only real measurement we have is a bound: a 1,000-row chunk does **not** complete inside a 20s abort against 37 indexes / 7,822 MB — i.e. **under 50 rows/s today**. The earlier 500–2,000 rows/s band was ~10–40× above our own evidence and is **withdrawn**. The index diet drops ~4.9 GB of 7.8 GB including both GIN trigram indexes (the most expensive on write), plausibly 2–3× → **~100–150 rows/s, unproven**.

**10,000 documents (Route C, post-fix)**
- Ingest: 10 requests at the batch tier ≈ 1 min; DB time ~1–2 min. Dedup is now an index scan.
- Anchoring: exactly one full batch = one OP_RETURN, but it waits for the next `*/30` tick.
- **~15–40 min to SECURED**, dominated by cron cadence plus one confirmation.
- **Verifiable:** +~1.25 h of proof fill at 8,000/hr.

**1,000,000 documents (Route C, post-fix)**
- Ingest: **~100 min floor from §1.10 alone**; ~1.9–2.8 h at 100–150 rows/s. Call it **~2 h**.
- Anchoring: **100 batches × 30 min = ~50 hours.** This is the wall, and it is the cron, not the chain.
- Chain **cost** is not a constraint: one Merkle root under one ~36-byte OP_RETURN per batch regardless of leaf count — 1M documents = **100 transactions**. The economics already work.
- **Verifiable:** +~5.2 days of proof fill for the new cohort alone (2,000 per 15 min), queued behind the existing ~2.97M-row deficit (~15 days at the same rate), plus ~2.2–2.6 GB of new `anchor_proofs` (measured: 2.24 KB/row at avg depth 12; ~2.6 KB at the depth-14 a 10,000-leaf batch implies).

**What FD-CHAIN-1 does and does not buy.** The defect is real: `listUnspent` uses `minconf=1`, so the treasury's own unconfirmed change from the previous batch is invisible, the `rpcUtxos.length >= 0` guard is true for `[]` so the fallback that would include unconfirmed UTXOs is never reached, and `hasFunds()` returns before any trigger is evaluated. But at a `*/30` cadence the block interval was **never the binding constraint** — so **fixing FD-CHAIN-1 alone changes the 1M wall-clock by exactly zero.** It is necessary, not sufficient.

**And chaining unconfirmed change hits a hard policy wall.** Bitcoin's 25-ancestor mempool limit returns `too-long-mempool-chain`, which is **in our `BROADCAST_REJECT_PATTERNS`** (verified) and therefore classified as a *definitive* reject: it fires a full unwind — 10,000 proof rows deleted, 10,000 intent marks cleared, refunds issued, 10,000 anchors reverted to PENDING. Reverted anchors keep their original `created_at` and the claim is `ORDER BY created_at ASC`, so **they are re-claimed first next cycle and fail identically**, every 30 minutes until a block confirms — ~200 sequential PostgREST round trips and ~30,000 row mutations per cycle on a 15 GB / 37-index table, at exactly the moment the operator believes throughput went up. **Bound the chain depth explicitly (≤20 unconfirmed ancestors, tracked, not discovered by rejection), and reclassify `too-long-mempool-chain` as transient backpressure that DEFERS rather than unwinds. Soak it across ≥26 consecutive batches — the originally-specified 3 cannot reach the limit.**

**Sub-50-hour requires a separate program**, any of: raising the scheduler cadence, an inner multi-batch loop within one invocation, or raising `BATCH_SIZE` past its lower-only clamp — each a T3 change with its own soak, each then bounded by the 25-ancestor limit and by proof throughput. Plausibly ~8–12 h. **Unmeasured; do not quote it.**

**Per-batch round-trip tail bounds the cadence lever.** With a 200-value IN-filter chunk and a 1,000-row PostgREST cap, one 10,000-anchor batch costs ~100–200 sequential HTTP calls inside a single-flight run lease. Raising the cadence toward one batch every few minutes makes invocations overlap, and each overlap is a wasted no-op. **Measure per-batch wall time in T1.6's soak before proposing any cadence change**, or it self-throttles against the lease.

### 6.5 Tiers, soak, rollback

| Change | Tier | Soak must exercise | Rollback |
|---|---|---|---|
| `DROP INDEX` linter coverage | T0 | CI unit tests | Revert |
| `bulk_create_anchors` rewrite | **T3** | 48 h isolated; 1k/10k/100k rows; concurrent same-user batches with **overlapping fingerprints** (proves lock removal + no double-charge); duplicate-heavy batch; migration rollback + reapply proof | Compensating migration |
| `anchor-bulk.ts` → `batch_insert_anchors` | **T2** | 12 h + rollback rehearsal; **cross-tenant attempt**; credit conservation across retried batches **with `ENABLE_ORG_CREDIT_ENFORCEMENT=true`** | Revert |
| Index drops (one per migration) | **T3** | 48 h; session-level `lock_timeout`; concurrent read load; **plan-regression check on every user-facing query**, especially filename/description search | `CREATE INDEX CONCURRENTLY` back — hours on a 15 GB table, **rehearse it** |
| Fairness lane (`p_exclude_pipeline` + backfill lane) | **T3** | 48 h; **interactive p95 latency under 1M-row backfill load** (replaces the false-passing "per-org isolation check"); claim EXPLAIN at 10k/100k/1M | Revert to single lane |
| Backfill queue + ingest API | **T3** | 48 h; kill worker mid-drain, prove exactly-once; re-run a completed batch, prove zero new anchors **and zero new debits with the credit flag ON**; soft-delete-then-reingest case; Trigger A/B/D | Feature-flag the route off |
| FD-CHAIN-1 + ancestor cap | **T3, mandatory** | 48 h; chained unconfirmed spends across **≥26** consecutive batches; assert DEFER not unwind at the limit | Revert; falls back to one batch per block |
| Revoke bulk RPC from `PUBLIC` + `anon` | **T3** (security) | Grant tests; `authenticated` path unaffected | Re-grant |

**§1.11A:** every T3 here changes migrations or mutable DB state, so each needs **exclusive** clean shared staging or an isolated rig with its own `*-staging` Cloud Run service. **Four soaks are currently live on four rigs — none of this can start on those.** Shared-staging evidence is merge-grade only if `staging-honesty-preflight.ts` reports `environment_type=clean_mirror`.

---

## 7. Landing order

**Week 1 — failures.** T1.7 → T1.1 (protect `idx_anchors_org_deleted_created`) → **T1.2a (PII, ship alone)** → T1.2b + T1.3 → T1.8 → T1.9. Then T1.4 + T1.5 **together** — extraction succeeding but blocked at the anchor gate is worse than today. Then T1.6 with the real-error fix and the Sentry `extra` hardening.

**Week 2–3 — Track 2** (pending D-1). Consumers first, in §5.4 order — **accountability report and OpenAPI spec before anything touches model output** — then the prompt, then the 0-row table drops last.

**Week 3+ — Track 3.** `DROP INDEX` linter → courtlistener throttle → fairness lane → index diet → `bulk_create_anchors` → `anchor-bulk.ts` → batch-tier limiter on `/anchor/bulk` → queue + ingest API → FD-CHAIN-1 + ancestor cap. Cadence program only after T1.6 yields a measured rows/s and per-batch wall time.

---

## 8. Open uncertainties — do not paper over these

1. **Sustained insert throughput post-index-diet is unmeasured.** Every 1M estimate rests on it. Bounded under 50 rows/s today; T1.6's soak must produce the real number.
2. **Claim-query plan at 1M PENDING is unvalidated.** Prod has 0 PENDING, so today's plan tells us nothing about backfill behavior. Must EXPLAIN at scale before shipping.
3. **The trigram indexes back a user-facing search surface I did not enumerate.** Verify before dropping.
4. **Raising the latency budget may increase 503s** on an already-saturated worker. Soak under concurrent cron load.
5. **Post-cadence-fix throughput is estimated, not measured.** The ~8–12 h figure for 1M is the least reliable number in this document.
6. **The 1,001/day duplicate 409s are unattributed.** If the founder's failure perception is inflated by them, the cause is not yet demonstrated.
7. **`batch_insert_anchors` is not tested end-to-end** — that requires a write. `AbortError` is proven as the failure mode; that a longer deadline *succeeds* is inference.
8. **Proof-fill rate under backfill load is untested.** The 2,000-per-15-min cap is a configured ceiling, not an observed throughput.

---

## Appendix — verification log

All figures verified 2026-08-20 against prod `vzwyaatejekddvltxyye` (read-only) and live GCP config.

| Claim | Method | Result |
|---|---|---|
| Dedup probe seq-scans | `EXPLAIN` on prod | Parallel Seq Scan, cost 1,776,181.20 |
| Fix works | `EXPLAIN` + `deleted_at IS NULL` | Index Scan `idx_anchors_org_deleted_created`, cost 2.03 |
| Comparand is auto-coerced | EXPLAIN filter text | `::bpchar` — no cast bug in `anchor-bulk.ts` |
| `bulk_create_anchors` defects | `pg_get_functiondef` regex | advisory lock ✓, `deleted_at IS NULL` already present ✓, `insert_failed` ✓, declares `text` ✓, O(N²) accum ✓ |
| Grants | `information_schema.routine_privileges` | `bulk_create_anchors`: PUBLIC + anon + authenticated + postgres + service_role; `batch_insert_anchors`: postgres + service_role |
| Scale | `GROUP BY status`, counts | 3,553,498 SECURED / 2 REVOKED / **0 PENDING** / 0 soft-deleted |
| Proofs | `count(*)` | 583,350 (16.4% coverage) |
| Manifests | `count(*)`, `count(DISTINCT anchor_id)` | 54 rows / 22 anchors |
| Templates | `jsonb_typeof(default_metadata->'fields')` | 22 system **array**, 3 CLE **object**, 2 customer (one `'{}'`) = 27 |
| CLE/CPE anchors | filtered count | 0 / 0 |
| `integrity_scores` | `count(*)` | 0 (gated off, not rejected) |
| Index inventory | `pg_stat_user_indexes` | 37 indexes, 7,822 MB, 15 GB heap |
| Claim is global FIFO | `pg_get_functiondef` | `ORDER BY created_at ASC`, no fairness |
| Batch job disables pipeline exclusion | source | `p_exclude_pipeline: false` |
| Claim timeout is silent | source | `if (allClaimed.length === 0) return emptyResult()` |
| Cron cadence | `gcloud scheduler jobs list` | `batch-anchors */30`, `populate-confirmation-proofs */15`, `daily-anchor-flush 0 3` |
| BATCH_SIZE ceiling | source | `Math.min(Math.max(env,100),10000)` — lower-only override |
| Proof fill cap | source | 2,000 rows/run |
| Back-catalog materializer | `cloud-scheduler.sh` | UNSCHEDULED, operator-gated |
| Prod AI config | `gcloud run services describe` | `GEMINI_MODEL`/`GEMINI_LITE_MODEL` = `gemini-2.5-flash` — **404 finding refuted** |
| Credit enforcement | env absent + `config.ts` | `boolFlag(false)`, unset → **dead code in prod** |
| Rate limits | `router.ts` | self-service bulk 10/min; AI 30/min; `/anchor/bulk` no route limiter (falls to 1,000/min) |
| Body limit | `index.ts:370` | `express.json()` — 100 kb default |
| Batch insert constants | source | `ANCHOR_INSERT_CHUNK=1_000`, `BATCH_INSERT_RPC_TIMEOUT_MS=20_000` vs 120 s server |
| PII path unguarded | grep | only `aiExtraction.ts` imports strippers; no upload component does |
| `MAX_BATCH_SIZE` | `ai-extract-batch.ts` | 50 |
| Review panel is a gate | `TemplateReviewPanel.tsx` | threshold 0.8, "REQUIRE explicit acknowledgment … before" |
| v6 prompt unreachable | `gemini.ts` | `systemInstruction: EXTRACTION_SYSTEM_PROMPT` hardcoded in untuned path |
| Accountability report coerces | `ai-accountability-report.ts` | `(confidence_scores?.overall ?? 0) * 100` → "0.0%" |
| OpenAPI requires confidence | `openapi.yaml:1323` | `required: [fields, confidence, provider]` |
| CPE second prompt | `cpe-extraction-prompt.ts` | instructs the 0.85 threshold |
| CLE/CPE normalizers | `professional-education.ts` | force review when confidence null/undefined |
| Sentry `extra` unscrubbed | `sentry.ts` | key-name filter only; `scrubString` not applied to values |
| Mempool chain limit | `utxo-provider.ts` | `too-long-mempool-chain` ∈ `BROADCAST_REJECT_PATTERNS` → definitive reject |
| Bulk charges at ingest | `anchor-bulk.ts:304` | `deductOrgCredit(…, queueable.length, 'anchor.bulk', body.batch_id)`; `batch_id` typed `string`, not `uuid` |

---

_Prepared read-only against production. No writes, no PR mutation, no rig contact._
