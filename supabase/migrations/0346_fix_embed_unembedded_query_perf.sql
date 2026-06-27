-- 0346_fix_embed_unembedded_query_perf.sql
-- Jira: SCRUM-2203 (follow-up to 0330) — embed-public-records cron statement-timeout regression.
-- NOTE: renumbered 0345 → 0346 (0345 collided with PR #1282 `fix/vacuum-anchors-cron-0345`,
--       which legitimately owns `0345_fix_vacuum_anchors_cron.sql`). 0346 is the next free prefix.
-- Bug Tracker: Confluence "Bug Tracker — Master Log" (worker silent-failure: POST /jobs/embed-public-records 500s every ~2 min, err 57014).
--
-- INCIDENT (prod vzwyaatejekddvltxyye, confirmed 2026-06-24):
--   Cloud Scheduler hits POST /jobs/embed-public-records every ~2 min. The handler
--   (services/worker/src/jobs/publicRecordEmbedder.ts) calls
--   get_unembedded_public_records(p_limit). The RPC now 500s every run with
--     err.code=57014 "canceling statement due to statement timeout" (statement_timeout=120000ms),
--   logged as "Failed to fetch unembedded public records" → "Public record embedding failed".
--   The job has fully stalled: zero records embedded for the duration of the regression.
--
-- ROOT CAUSE (confirmed via prod read-only EXPLAIN + bounded probes, 2026-06-24):
--   0330 rewrote the fetch to a NOT EXISTS anti-join driven, in created_at ASC order, off
--   idx_public_records_created_at:
--       Nested Loop Anti Join
--         -> Index Scan using idx_public_records_created_at on public_records  (ordered)
--         -> Index Only Scan using idx_pre_record_id on public_record_embeddings (probe)
--       Limit ... LIMIT p_limit
--   That was index-driven and fast in 2026-05 when only ~328K of ~3.03M records were embedded
--   and the un-embedded rows were spread across the created_at range. 0330 itself PREDICTED the
--   regression: "as the embedding backlog drains... the ordered scan's leading edge increasingly
--   skips already-embedded rows before collecting p_limit." That is exactly what happened.
--
--   The embedder processes OLDEST-FIRST (ORDER BY created_at ASC). After months of draining,
--   the OLDEST rows are now all embedded and the un-embedded backlog sits at the NEWEST edge:
--     - public_records:           ~3,122,809 rows / 6.3 GB
--     - public_record_embeddings: ~2,131,523 rows / 8.8 GB (~2,124,328 distinct records)
--     - un-embedded backlog:      ~998K records, all at the NEWEST end of created_at.
--   Bounded prod probe: of the OLDEST 50,000 records by created_at, 50,000 / 50,000 are already
--   embedded (0 un-embedded). So the created_at-ASC anti-join must WALK and PROBE through
--   ~2.1M consecutive already-embedded rows at the leading edge before it can collect the first
--   un-embedded row. The planner's cost model assumes un-embedded rows are uniformly distributed
--   (its top-level Limit cost looks cheap: 0.86..2336.15) and badly under-estimates how far into
--   the ordered scan it must travel; in reality every match is at the far end. That ~2.1M-row
--   leading-edge walk + ~2.1M index probes blows past the 120 s statement_timeout → 57014.
--   (Independent confirmation: even SELECT min(created_at) over the un-embedded set times out.)
--
--   0330's documented "optional (created_at, id) hardening index" would NOT have fixed this:
--   it still has to walk every already-embedded row at the leading edge in created_at order.
--   The structural problem is that "is this record embedded?" is encoded ONLY as the existence
--   of a row in a SECOND 8.8 GB table, so a partial index on public_records cannot express the
--   un-embedded predicate, and no ordering of the anti-join avoids the dead-weight walk.
--
-- FIX (principled — materialize the un-embedded marker, then partial-index it):
--   1. Add public_records.embedded_at timestamptz NULL. NULL == "not yet embedded".
--   2. AFTER INSERT trigger on public_record_embeddings sets the parent's embedded_at = now()
--      (idempotent: only when still NULL). This keeps the marker in lock-step with the embeddings
--      table on the existing worker write path with no worker code change.
--   3. Partial index idx_public_records_unembedded ((created_at) WHERE embedded_at IS NULL) —
--      contains ONLY the ~998K un-embedded rows, in created_at order. (Standalone CONCURRENTLY;
--      see "NON-TRANSACTIONAL" below.)
--   4. Rewrite get_unembedded_public_records to filter `WHERE pr.embedded_at IS NULL` (drop the
--      cross-table NOT EXISTS). The planner then does a plain forward Index Scan over the partial
--      index and stops after p_limit — no anti-join, no dead-weight walk, no Sort.
--
--   PROOF the new plan is index-driven: the schema already has an analogous partial index
--   idx_public_records_unanchored ((created_at) WHERE anchor_id IS NULL). Prod read-only EXPLAIN
--   of the IDENTICAL fetch shape against it —
--       SELECT ... FROM public_records WHERE anchor_id IS NULL ORDER BY created_at ASC LIMIT 500
--   — gives: "Limit (cost=0.42..237.65) -> Index Scan using idx_public_records_unanchored",
--   no Sort, no anti-join. idx_public_records_unembedded will produce the same plan for the
--   embedded_at IS NULL predicate (it covers ~998K vs the unanchored index's ~178K, both trivial).
--
--   Contract preserved EXACTLY: same function name + signature (p_limit integer DEFAULT 100),
--   same RETURNS TABLE(id, title, source, record_type, metadata) columns + order, same projected
--   columns, same created_at ASC ordering, same LIMIT p_limit, same LANGUAGE sql / STABLE /
--   SECURITY DEFINER / SET search_path = public, same owner + grants (untouched → the service-role
--   cron caller keeps EXECUTE). No in-body access guard added (service-role maintenance RPC, as in
--   0330). No API/type change beyond the additive nullable column (§1.8 additive).
--
-- TRANSACTIONAL parts of THIS migration (safe under `supabase db push`):
--   * ADD COLUMN embedded_at (metadata-only on PG11+, no table rewrite — DEFAULT omitted).
--   * trigger function + trigger on public_record_embeddings.
--   * CREATE OR REPLACE FUNCTION get_unembedded_public_records.
--   * NOTIFY pgrst, 'reload schema'.
--
-- ===========================================================================================
-- NON-TRANSACTIONAL OPERATOR STEPS (run STANDALONE, OUTSIDE any transaction, per the 0313/0330
-- convention — `supabase db push` wraps migrations in a txn and CREATE INDEX CONCURRENTLY /
-- batched backfill cannot run there). Apply on staging during the soak and on prod at cutover:
--
--   -- (A) BACKFILL the marker for the ~2.1M already-embedded records, in bounded batches so no
--   --     long lock / no single huge transaction. Run repeatedly until 0 rows updated:
--   --       (psql) \set ECHO all
--   --       DO $$
--   --       DECLARE n bigint;
--   --       BEGIN
--   --         LOOP
--   --           WITH cte AS (
--   --             SELECT pr.id
--   --             FROM public_records pr
--   --             WHERE pr.embedded_at IS NULL
--   --               AND EXISTS (SELECT 1 FROM public_record_embeddings pre
--   --                           WHERE pre.public_record_id = pr.id)
--   --             LIMIT 10000
--   --             FOR UPDATE SKIP LOCKED
--   --           )
--   --           UPDATE public_records pr
--   --             SET embedded_at = now()
--   --           FROM cte WHERE pr.id = cte.id;
--   --           GET DIAGNOSTICS n = ROW_COUNT;
--   --           RAISE NOTICE 'backfilled % rows', n;
--   --           EXIT WHEN n = 0;
--   --           COMMIT;            -- requires a DO block run in a procedure context, or loop in shell
--   --         END LOOP;
--   --       END $$;
--   --     (Operationally simpler: a shell loop running the single UPDATE...LIMIT 10000 statement
--   --      until it reports 0 rows; each statement auto-commits. The backfill is RESUMABLE and
--   --      the trigger keeps NEW embeddings correct while it runs.)
--   --
--   -- (B) CREATE the partial index CONCURRENTLY (after — or during — backfill; either order is
--   --     correct, the index just gets smaller as the backfill progresses):
--   --       CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_records_unembedded
--   --         ON public.public_records (created_at) WHERE embedded_at IS NULL;
--   --
--   --   Until (B) lands, the rewritten RPC falls back to a Seq-Scan-filter on embedded_at IS NULL;
--   --   that is still BOUNDED by LIMIT p_limit and returns the newest-edge backlog without the
--   --   2.1M dead-weight walk, but (B) is what makes it a cheap Index Scan at steady state — apply
--   --   it as part of cutover.
-- ===========================================================================================
--
-- ROLLBACK:
--   -- Standalone (outside a txn), if the partial index was created:
--   --   DROP INDEX CONCURRENTLY IF EXISTS public.idx_public_records_unembedded;
--   -- Then, transactionally, restore the 0330 NOT EXISTS body + drop the trigger/column:
--   --   (restore get_unembedded_public_records from 0330_scrum2203_unembedded_records_query_perf.sql)
--   --   DROP TRIGGER IF EXISTS trg_public_record_embeddings_mark_embedded ON public.public_record_embeddings;
--   --   DROP FUNCTION IF EXISTS public.mark_public_record_embedded();
--   --   ALTER TABLE public.public_records DROP COLUMN IF EXISTS embedded_at;
--   --   NOTIFY pgrst, 'reload schema';
--   -- (The 0330 plan regresses to the timeout, so only roll back the RPC together with re-adding
--   --  a working fast path; prefer rolling forward.)

-- ── (1) Marker column: NULL = not yet embedded ──────────────────────────────
ALTER TABLE public.public_records
  ADD COLUMN IF NOT EXISTS embedded_at timestamptz;

COMMENT ON COLUMN public.public_records.embedded_at IS
  'When a vector embedding was first stored for this record (maintained by trg_public_record_embeddings_mark_embedded). NULL = un-embedded; drives idx_public_records_unembedded + get_unembedded_public_records. SCRUM-2203 / mig 0346.';

-- ── (2) Trigger: keep embedded_at in lock-step with public_record_embeddings ──
CREATE OR REPLACE FUNCTION public.mark_public_record_embedded()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  -- Idempotent: only set on the first embedding for a record; later/duplicate
  -- embedding rows (the table has no unique constraint on public_record_id) leave
  -- the original timestamp intact. Guarded UPDATE so re-embeds are no-ops.
  UPDATE public.public_records
    SET embedded_at = COALESCE(embedded_at, now())
  WHERE id = NEW.public_record_id
    AND embedded_at IS NULL;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.mark_public_record_embedded() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_public_record_embeddings_mark_embedded
  ON public.public_record_embeddings;

CREATE TRIGGER trg_public_record_embeddings_mark_embedded
  AFTER INSERT ON public.public_record_embeddings
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_public_record_embedded();

-- ── (3) Partial index is created STANDALONE / CONCURRENTLY — see operator steps above.
--        (Intentionally NOT created here: a plain CREATE INDEX would take an ACCESS EXCLUSIVE
--         build lock on the 6.3 GB hot table; CREATE INDEX CONCURRENTLY cannot run in the
--         migration's wrapping transaction. Per 0313/0330 convention it is operator-applied.)

-- ── (4) Rewrite the fetch RPC to use the materialized marker ─────────────────
--        Contract identical to 0330; only the WHERE predicate changes
--        (NOT EXISTS cross-table anti-join → embedded_at IS NULL single-table filter).
CREATE OR REPLACE FUNCTION public.get_unembedded_public_records(p_limit integer DEFAULT 100)
    RETURNS TABLE(id uuid, title text, source text, record_type text, metadata jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT pr.id, pr.title, pr.source, pr.record_type, pr.metadata
  FROM public_records pr
  WHERE pr.embedded_at IS NULL
  ORDER BY pr.created_at ASC
  LIMIT p_limit;
$$;

ALTER FUNCTION public.get_unembedded_public_records(integer) OWNER TO postgres;

NOTIFY pgrst, 'reload schema';
