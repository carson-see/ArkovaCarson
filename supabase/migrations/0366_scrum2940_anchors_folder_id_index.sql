-- =============================================================================
-- 0366 — anchors.folder_id partial index (SCRUM-2940) — CONCURRENTLY, NO TXN
--
-- MUST STAY IN ITS OWN FILE WITH NO BEGIN/COMMIT.
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction block. The
--   Supabase migration builder wraps a file that contains BEGIN/COMMIT (or any
--   multi-statement DDL it decides to wrap) in one transaction; a bare file
--   with a single CONCURRENTLY statement and no explicit transaction is applied
--   outside a transaction (0313 non-transactional convention). Do NOT add
--   BEGIN/COMMIT here and do NOT merge this statement back into 0365.
--
-- WHY CONCURRENTLY.
--   anchors is ~2.97M rows in prod. A plain CREATE INDEX takes a SHARE lock
--   that blocks every INSERT/UPDATE for the whole build (the nightly 3am batch
--   drain + live anchoring would stall). CONCURRENTLY builds without blocking
--   writes at the cost of two table scans and running outside a txn.
--
-- OPERATOR NOTE (prod apply).
--   CONCURRENTLY can leave an INVALID index if the build fails midway. Apply
--   during the T3 soak / a low-write window, then verify:
--     SELECT indisvalid FROM pg_index
--       WHERE indexrelid = 'public.idx_anchors_folder_id'::regclass;  -- expect t
--   If invalid: DROP INDEX CONCURRENTLY public.idx_anchors_folder_id; re-run.
--   Partial (WHERE folder_id IS NOT NULL) keeps the index tiny — only filed
--   records are indexed; the overwhelming Unfiled majority costs nothing.
--
-- ROLLBACK:
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_anchors_folder_id;
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_folder_id
  ON public.anchors (folder_id)
  WHERE folder_id IS NOT NULL;
