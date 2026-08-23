# Bulk upload + AI extraction — verified root causes (2026-08-20)

Every claim below was **verified directly against production** (`vzwyaatejekddvltxyye`) or
against the working tree, not taken from an agent report. Claims that did not survive
verification are listed at the end, including ones I had asserted myself.

Prod worker `arkova-worker-01313-ram`. Anchors: **3,553,498 SECURED**, 65 SUBMITTED,
2 REVOKED, **0 PENDING**.

---

## F-1 — §1.6 BREACH: the CSV path strips no PII (live, most severe)

`AIExtractionStep.tsx` built its extraction text by serialising every column verbatim and
POSTed it to `/api/v1/ai/extract-batch`:

```ts
columns.map((col) => `${col.name}: ${row.data[col.name] ?? ''}`)
```

**Verified:** `grep -c` for `stripPII|piiStrip` returns **0** in all three files of the CSV
path — `AIExtractionStep.tsx`, `BulkUploadWizard.tsx`, `csvParser.ts`. The strippers exist
and are heavily tested, but the only importer is `src/lib/aiExtraction.ts`, which is the
**document** path.

§1.6 calls client-side PII stripping a "foundational privacy guarantee" and permits only
PII-stripped metadata to reach the server. Raw SSNs, emails, phone numbers and dates of
birth were shipped for every CSV bulk upload under the 50-row cap. `ColumnMapping` even has
a dedicated `email` field, so an email column is a mapped, expected input.

**Fixed:** PR #2302 — `src/lib/csvRowText.ts` as a single choke point, column-role
redaction rather than NER (a CSV is structured; NER is for unstructured OCR text and costs
per row on a path that is already too slow). 15 tests, 98 green across the PII suites.

**Sequencing warning:** the 50-row cap is currently *the only thing bounding the blast
radius*. Chunking to fix F-3 before F-1 lands would scale the breach. **Strip first, chunk
second.**

---

## F-2 — `bulk_create_anchors` casts the indexed column, so every dedup probe seq-scans

`anchors.fingerprint` is `character(64)`. The function declares `anchor_fingerprint text`
and compares `WHERE fingerprint = anchor_fingerprint`, so Postgres casts the **indexed
column** to text and no fingerprint index is usable.

`EXPLAIN` on prod, the function's exact predicate:

| Comparand | Plan | Cost |
|---|---|---|
| `::text` (what the function does) | Parallel Seq Scan | **1,783,431** |
| `::character(64)` | Index Scan `idx_anchors_fingerprint_lookup` | **2.78** |

**649,000× — per row.** The function runs one probe per row, inside a
`pg_advisory_xact_lock` keyed on the caller, under its own `SET statement_timeout = '60s'`.

This is the **same bug class as SCRUM-3031**, which was fixed in `batch_insert_anchors` by
migration 0370 and **never fixed in `bulk_create_anchors`**. Verified directly:

```sql
SELECT proname, pg_get_functiondef(oid) ILIKE '%::bpchar%' OR ... AS has_bpchar_cast
--  batch_insert_anchors  -> true      (fixed)
--  bulk_create_anchors   -> false     (not fixed)
```

Severity scales with anchors already owned, so it passes on a fresh demo account and fails
on any real one — and it is **O(N²) during backfill**, since each insert enlarges the table
the next probe scans.

Two further defects in the same function, both verified in its source:

- `results := results || jsonb_build_object(...)` per row — **O(N²) byte copying**.
- `EXCEPTION WHEN OTHERS THEN failed_count := failed_count + 1` — a duplicate-key violation
  is reported to the user as **failed**, not skipped.

---

## F-3 — The client sends N rows to an endpoint capped at 50

`AIExtractionStep.tsx:94` does `rows.map(...)` with **no chunking**, then POSTs to
`/api/v1/ai/extract-batch`, whose Zod schema is
`.max(MAX_BATCH_SIZE)` with `MAX_BATCH_SIZE = 50` (`ai-extract-batch.ts:45,75`). The code
comment there even reads "can process many rows" — the author believed it could.

**Every CSV over 50 rows fails deterministically.** This is the "AI extraction constantly
failing" complaint, and it is a client/server contract mismatch, not a model problem.

---

## F-4 — 100 kb body cap contradicts the 1000-row API cap

`services/worker/src/index.ts:370` is `app.use(express.json());` with **no `limit`**, so
body-parser's **100 kb** default applies. `anchor-bulk.ts:77` allows `.max(1000)` rows. A
realistic row with filename and credential type is ~121–250 bytes, so the request returns
**413** at roughly 400–850 rows — well before the documented 1000-row limit.

---

## F-5 — The confidence gate is live at 0.4 and unset in prod

`services/worker/src/jobs/anchor.ts:177`:

```ts
const CONFIDENCE_THRESHOLD = parseFloat(process.env.ANCHOR_CONFIDENCE_THRESHOLD ?? '0.4');
if (confidence < CONFIDENCE_THRESHOLD) { /* revertToPending, _review_reason: 'low_confidence' */ }
```

`ANCHOR_CONFIDENCE_THRESHOLD` is **not set** on the prod worker, so the 0.4 default is
active and sub-threshold anchors are reverted to PENDING. This is the mechanism behind the
"it shouldn't do anything with document confidence" directive.

**Scope check, against my own expectation:** prod currently has **0 PENDING anchors**, so
there is *no* confidence-blocked backlog today. The gate is a live hazard, not a live
outage. Do not describe it as one.

---

## Claims that did NOT survive verification

| Claim | Verdict |
|---|---|
| Role `statement_timeout` of 30 s kills the probe | **Corrected.** `bulk_create_anchors` sets its own `statement_timeout = '60s'`, which overrides the role. 60 s is the real budget. |
| Single-path AI latency budget default is 4,500 ms, below Gemini's 5,806 ms p50 | **Unverified.** No `AI_EXTRACTION_LATENCY_BUDGET_MS` config field exists in `config.ts` — only a comment referencing it. The **batch** default is `aiBatchRowLatencyBudgetMs = 8_000`. Do not cite 4,500. |
| Gemini model 404s in prod | **Refuted.** `GEMINI_MODEL=gemini-2.5-flash` confirmed on the live worker. Applies to rigs, not prod. |
| Live anchor count ~2.97M | **Stale.** Prod is **3,553,498** SECURED as of 2026-08-20. |
| wave2's load harness is failing 99% of requests | **Refuted** (from the parallel soak work). The harness deliberately probes an absent anchor id (404) and an admin-gated endpoint unauthenticated (401/429) to exercise lookup, auth middleware and rate limiter. It counts every non-2xx as `fail`. No harness change made. |

---

## Recommended order

1. **F-1** — merge #2302. Live privacy breach; blocked only by soak capacity.
2. **F-2** — one-line type fix to `bulk_create_anchors` (declare `character(64)` or cast at
   the comparison). Migration, therefore T3. Highest performance payoff available.
3. **F-4** — set an explicit `limit` on `express.json()` consistent with the 1000-row cap.
4. **F-3** — chunk to 50, **only after F-1 has landed**.
5. **F-5** — Carson's call on removing the confidence gate. Note `confidence` is `required`
   in the published OpenAPI, so partners with generated clients break if the field is
   dropped rather than defaulted.
