-- =============================================================================
-- 0379 — envelope-reconciliation lookup indexes (SCRUM-2904 follow-up)
--
-- MUST STAY IN ITS OWN FILE WITH NO BEGIN/COMMIT.
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction block. The
--   Supabase migration builder wraps a file containing BEGIN/COMMIT in one
--   transaction; a bare file with only CONCURRENTLY statements and no explicit
--   transaction is applied outside a transaction (0313/0366 convention).
--
-- WHY (production incident, 2026-08-01 — Sentry ARKOVA-WORKER-2B).
--   `findExistingEnvelopeAnchor` (services/worker/src/jobs/
--   docusign-anchor-reconciliation.ts) is the envelope-level idempotency guard
--   both the declared-hash rules path and the server-fetched connector path run
--   before creating an anchor. It matched the envelope id across three metadata
--   keys with ONE unindexed OR:
--
--     ... WHERE org_id = $1 AND deleted_at IS NULL AND status <> 'REVOKED'
--         AND (   metadata->>'source_envelope_id' = $2
--              OR metadata->>'envelope_id'        = $2
--              OR metadata->>'external_ref'       = $2 )
--
--   No index could serve that OR, so Postgres scanned `anchors`. On org
--   40383eb2-f1cd-4a85-8099-afafff95e5cf — which also holds the entire
--   public-records-feeder corpus (2,974,731 of the ~2.97M prod anchors) — the
--   scan exceeded statement_timeout and the query failed with
--   "canceling statement due to statement timeout". Every real DocuSign
--   envelope for that org therefore failed to materialize into an anchor:
--     - connector_artifact 921347cc-9a70-4c9b-be79-a651f0fe4e2b → status
--       `failed` (fetched + hashed fine; died at materialization), and
--     - organization_rule_executions 3e947424-3fc3-4d83-a984-7be0771695a1
--       DLQ'd on 2026-07-27 with the identical error via the other call site.
--
--   The worker code is split into one equality query per key in the same
--   change; these three indexes are what make each of those queries an index
--   lookup instead of a scan.
--
-- WHY PARTIAL (write-path cost — SCRUM-1286).
--   `anchors` is write-hot and already carries a large index footprint. The
--   predicate `(metadata->>'<key>') IS NOT NULL` keeps each index to only the
--   anchors that actually carry that envelope key — a few thousand connector /
--   DocuSign rows — instead of all ~2.97M. The public-records corpus that
--   caused the incident is excluded entirely, so the nightly 3am batch drain
--   and live anchoring pay effectively nothing per insert. MEASURED on a
--   2,974,734-row reproduction (Postgres 15.8): each index is 16 kB.
--
--   The worker query also restates `IS NOT NULL` alongside the equality. That
--   is belt-and-braces, not a requirement — measured on the same reproduction,
--   the planner picks the index with or without it (it proves `x = c` implies
--   `x IS NOT NULL` from operator strictness).
--
--   `created_at` is the trailing column so `ORDER BY created_at LIMIT 1`
--   (oldest live match wins — the reuse-the-same-anchor rule) is satisfied by
--   the index order with no sort step.
--
-- WHY CONCURRENTLY.
--   A plain CREATE INDEX takes a SHARE lock that blocks every INSERT/UPDATE on
--   `anchors` for the whole build. CONCURRENTLY builds without blocking writes,
--   at the cost of two table scans and running outside a txn.
--
-- OPERATOR NOTE (prod apply).
--   CONCURRENTLY can leave an INVALID index if the build fails midway. Apply
--   during the T3 soak / a low-write window, then verify ALL THREE:
--     SELECT c.relname, i.indisvalid
--       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--      WHERE c.relname IN ('idx_anchors_org_meta_source_envelope_id',
--                          'idx_anchors_org_meta_envelope_id',
--                          'idx_anchors_org_meta_external_ref');  -- expect 3x t
--   If any is invalid: DROP INDEX CONCURRENTLY that one and re-run it.
--
--   Post-apply, confirm the plan actually uses them (the whole point):
--     EXPLAIN ANALYZE SELECT id, public_id, created_at FROM public.anchors
--      WHERE org_id = '40383eb2-f1cd-4a85-8099-afafff95e5cf'
--        AND metadata->>'external_ref' = '<envelope-id>'
--        AND metadata->>'external_ref' IS NOT NULL
--        AND deleted_at IS NULL AND status <> 'REVOKED'
--      ORDER BY created_at LIMIT 1;
--   Expect an Index Scan on idx_anchors_org_meta_external_ref, NOT a Seq Scan.
--
-- ROLLBACK:
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_org_meta_source_envelope_id;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_org_meta_envelope_id;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_org_meta_external_ref;
--   (Rolling back restores the unindexed-lookup timeout — the worker's split
--   queries are correct without the indexes, just slow on large orgs.)
-- =============================================================================

-- anchor-index-justification: the DocuSign/connector envelope-level idempotency guard looks up anchors by (org_id, metadata->>'source_envelope_id') before every anchor insert; unindexed it scanned all ~2.97M rows and hit statement_timeout in prod on 2026-08-01, blocking every real envelope from anchoring. Partial on IS NOT NULL so only envelope-carrying rows are indexed and the write path stays cheap.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_org_meta_source_envelope_id
  ON public.anchors (org_id, (metadata->>'source_envelope_id'), created_at)
  WHERE deleted_at IS NULL AND (metadata->>'source_envelope_id') IS NOT NULL;

-- anchor-index-justification: same envelope-level idempotency guard, second of the three metadata keys the two anchoring paths persist the envelope id under (connector path writes metadata->>'envelope_id'); without it that disjunct falls back to a full anchors scan. Partial on IS NOT NULL keeps it to envelope-carrying rows only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_org_meta_envelope_id
  ON public.anchors (org_id, (metadata->>'envelope_id'), created_at)
  WHERE deleted_at IS NULL AND (metadata->>'envelope_id') IS NOT NULL;

-- anchor-index-justification: same envelope-level idempotency guard, third metadata key — this is the one the connector-artifact drain actually keys on (connector_artifact.external_ref), so it is the index that unblocks the failed 2026-08-01 materialization. Partial on IS NOT NULL keeps it to envelope-carrying rows only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_org_meta_external_ref
  ON public.anchors (org_id, (metadata->>'external_ref'), created_at)
  WHERE deleted_at IS NULL AND (metadata->>'external_ref') IS NOT NULL;
