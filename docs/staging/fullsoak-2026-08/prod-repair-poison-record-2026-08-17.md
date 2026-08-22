# Prod repair — the 16-day poison record behind the Sentry alert storm

**2026-08-17T18:1xZ. One-row data repair in prod `public_records`. Root cause fully
established before touching anything.**

## Causal chain, each link verified

1. `public_records` row `e9143d08-9706-4d30-97cb-44f2c1be308b` (openalex W7159838936, a
   mathematics preprint) has `metadata.abstract` of **1,914 codepoints = 2,000 UTF-16
   units including 86 astral-plane characters** (mathematical alphanumeric symbols).
2. `publicRecordDescription` (`services/worker/src/jobs/publicRecordAnchor.ts:575-582`)
   does `abstract.slice(0, 500)` — a **UTF-16 code-unit** slice that cuts at unit 500
   and **splits a surrogate pair**, leaving a lone high surrogate in `description`.
3. Lone surrogates are invalid JSON. PostgREST rejects the insert:
   **`PGRST102 "Empty or invalid json"`** — observed for exactly this fingerprint
   (`18ce56cd…`) at 17:40, 17:50, 18:00Z, i.e. every `*/10` cycle. No other fingerprint
   has failed in 48h.
4. The batch RPC fails wholesale on the poisoned chunk, falls back to serial inserts
   (`insertAnchorSerialFallback`), the row's individual insert fails, `continue` — **no
   quarantine, no retry-cap**. The fetch orders `created_at` ascending, so this oldest
   row re-poisons the head of the queue every 10 minutes. 85,957 later openalex records
   linked fine around it.
5. `pipelineThroughputMonitor` condition B fires on the age of the oldest unlinked record
   with no count floor → **fatal Sentry event every 30 min for 16 days** (SCRUM-3156).

## The repair (executed)

Stripped astral characters from this one row's `metadata.abstract`
(`regexp_replace` over U+10000–U+10FFFF): 1,914 → 1,828 chars, **0 astral remaining**.
No surrogate can now be split at any cut. `content_hash` (the anchored fingerprint) is
untouched — it was computed at ingest and is not derived from the abstract. Display
metadata only; reversible from the OpenAlex source (W7159838936) if ever needed.

Expected within ~10 min: the linker inserts the anchor, `anchor_id` backfills, unlinked
count returns to 0, and the fatal alert stream stops.

## Why this was in-scope during the freeze

The freeze protects the rig's evidence and prod deploys. This is a single-row metadata
repair on a prod table unrelated to the soak, stopping ~48 false fatal alerts/day that
were actively training operators to ignore the alert channel.

## The two durable fixes this demands (queued, draft-PR)

1. **Surrogate-safe truncation** in `publicRecordAnchor.ts` — both `slice(0, 500)`
   (description) and `slice(0, 180)` (filename): well-formed slicing (drop a trailing
   lone surrogate after the cut / `String.prototype.toWellFormed()`), with a regression
   test using this exact abstract shape. Any future astral-plane record re-creates this
   otherwise.
2. **Quarantine/retry-cap for per-row insert failures** — a row that fails N serial
   attempts must be set aside and surfaced, not silently retried forever at the head of
   the queue. This poison pill cost 16 days; the mechanism guarantees a repeat.

Related tickets: SCRUM-3156 (alert storm), SCRUM-3155 (untriaged 08-14 outage).
