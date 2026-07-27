# Task 7 — Advisor-triage analysis: the 0359+ migration train (SCRUM-2918/2905/2971)

**Mode:** analysis only. **No migration files authored in-window (W3).** Actual `.sql` authoring starts Jul 22 after the prefix registry (SCRUM-2979) is live; train freezes Jul 28 EOD. Verified against `origin/main` (baseline) this session.

## Prefix reservations (proposed order — reserve in SCRUM-2979 registry Jul 22)
0358 is taken (`anchor_txid_journal`, #1552). Next free = **0359**. Proposed contiguous block **0359–0363** (final count depends on cut-lines below).

## Triage table

| Cand | Story | What it changes | Migration-shaped? | Tier | Depends on | Train status |
|---|---|---|---|---|---|---|
| 0359 | **0340-trigger predicate** (from Task-3 memo §5-C) | Extend `enforce_secured_anchor_proof_complete` predicate to `(merkle_root AND proof_path) OR proof_completeness_class IN ('direct_anchored','already_complete')` so the GUC can be enabled without rejecting direct anchors | **YES** (CREATE OR REPLACE FUNCTION) | T3 | **CTO row-shape ruling (Jul 24)** | **NEVER descopes** — materializer support; gates the Aug-4 execute path |
| 0360 | **SCRUM-2971** billing_events idempotency | `billing_events` already has `UNIQUE(idempotency_key)` + `UNIQUE(stripe_event_id)` (baseline). 2971 targets a **different** idempotency dimension — **needs the ticket to name which path is unguarded** (e.g., a composite (org_id,event_type,period) key, or an event class that bypasses the existing uniques) | **YES** (unique index/constraint) | T3 | Jira detail (unresolved this session) | **NEVER descopes** (treasury correctness) — but **BLOCKED on scoping** the exact missing key |
| 0361 | **SCRUM-2559** embed-public-records timeout | `get_unembedded_public_records` RPC anti-join (public_records LEFT JOIN credential_embeddings) times out (2-min 500s) at ~255k unembedded scale. Fix = supporting index (e.g. partial index for the unembedded predicate / `credential_embeddings(anchor_id)`) and/or RPC rewrite | **YES** (CREATE INDEX / CREATE OR REPLACE FUNCTION) | T2 | none | **CUT-LINE #1** (falls out first; alert-dedupe fallback via SCRUM-2981) |
| 0362 | **SCRUM-2558** vacuum-anchors | No dedicated job file in repo; almost certainly autovacuum tuning on `anchors` (`ALTER TABLE … SET (autovacuum_*)`) or a scheduled VACUUM — bloat control ahead of the ~2.98M Aug-4 insert (feeds SCRUM-2984) | **PARTIAL** — ALTER TABLE autovacuum settings are migration-shaped; a Cloud Scheduler VACUUM job is NOT | T2 | none | **CUT-LINE #2** (descopes after 2559) |
| 0363 | **Advisor index findings** (Supabase perf advisor, release-queue-drain runbook) | Missing covering index `external_document_versions(anchor_id)` **confirmed absent** in baseline; plus unindexed-FK / duplicate-index / permissive-policy findings from the post-DDL advisor run | **YES** (CREATE INDEX; low-risk) | T2 | none | Bundle the low-risk index adds; keep permissive-policy/SECURITY-DEFINER findings as a **separate security review**, not this train |

## Stories needing Jira detail (could not resolve read-only — Atlassian unauthorized this session)
- **SCRUM-2918, SCRUM-2905** — named as advisor-triage content in the safe-work order but **not referenced anywhere in repo/HANDOFF**. Their exact scope (migration-shaped? which table?) must come from Jira before prefix assignment. **Flagged: do not reserve a prefix until scoped.**
- **SCRUM-2971** — confirmed migration-needed (HANDOFF -012/-013 from #1568 cross-review) but the *specific* idempotency gap is unspecified given the existing uniques (above).

## Ordering / dependency notes
- **0359 (trigger) is the spine** — it must precede any GUC flip and is the schema half of the Aug-4 materializer story (SCRUM-2916/2917). It is gated on the Jul-24 CTO ruling; if the ruling picks "GUC stays OFF for the back catalogue" (Task-3 §5-C alternative), 0359 is deferred and the materializer labels-only.
- **Cut-lines (pre-agreed, lane plan):** 2559 → then 2558 fall out of the train first; the trigger change + materializer never descope. So the **guaranteed** train is 0359 (+0360 once scoped); 0361/0362/0363 are load-bearing-optional.
- **Concurrency-safe index builds:** every index candidate (0361/0363) should be authored with `CREATE INDEX CONCURRENTLY` — but that **cannot run inside the `BEGIN;…COMMIT;` migration wrapper** (confirmed; 0354's own header notes this). These need the split-transaction migration pattern (or a follow-up maintenance step).
  - **⚠ CONCURRENTLY HAS ALREADY FAILED ON THIS PROD DB (perf review F2).** The baseline dump header records **3 invalid indexes excluded by pg_dump** (`indisvalid=false` — failed `CREATE INDEX CONCURRENTLY` on prod that left debris). So any CONCURRENTLY build here **must** include a verify-and-reindex step (`SELECT … WHERE indisvalid=false` → `DROP INDEX`/`REINDEX`) and must **not** run inside the ~2–3h materialize window. Budget this explicitly.
  - **The materializer's own post-fill index** (if any is added on `anchor_proofs` as it grows 6,110→~3M): a plain `CREATE INDEX` takes ACCESS EXCLUSIVE and blocks the live anchor→proof write path — CONCURRENTLY is mandatory there, with the same reindex-verify caveat.

## Recommendation
1. Reserve **0359 (trigger)** immediately after the Jul-24 ruling; it is the only strictly-required T3 migration for the Aug-4 path.
2. Get Jira scope for **2971 / 2918 / 2905** before reserving 0360+ — three of the five candidates are under-specified.
3. Treat **0361/0362/0363** as a batched T2 perf/index sub-train that can slip past the Jul-28 freeze into a follow-up without blocking launch (they are optimizations, not correctness gates), consistent with the pre-agreed cut-lines.

_Lane 1 (DBA persona), 2026-07-20 evening. Analysis only; zero migration files authored. Train assembly Jul 22 post-registry._
