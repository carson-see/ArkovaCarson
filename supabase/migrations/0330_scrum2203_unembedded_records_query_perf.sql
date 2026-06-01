-- SCRUM-2203 — get_unembedded_public_records() rewrite (embed-public-records cron timeout).
--
-- INCIDENT:
--   Production Cloud Scheduler job `embed-public-records` (*/2 * * * *) hits
--   POST /jobs/embed-public-records, which calls get_unembedded_public_records(p_limit).
--   The RPC 500s every ~2 minutes with
--     "RPC get_unembedded_public_records failed: canceling statement due to statement timeout".
--
-- ROOT CAUSE (confirmed via prod EXPLAIN on ref vzwyaatejekddvltxyye, 2026-05-31):
--   The baseline body used a LEFT JOIN public_record_embeddings ... WHERE pre.id IS NULL
--   anti-join with ORDER BY created_at ASC LIMIT p_limit. On the ~3.03M-row / 6.3 GB
--   public_records table (~2.68M of them un-embedded; public_record_embeddings ~328K rows)
--   the planner could not push the LIMIT through the join, so it chose:
--       Parallel Seq Scan on public_records (cost ~443880)
--     → Parallel Hash Left Join (Hash Cond pr.id = pre.public_record_id, Filter pre.id IS NULL)
--     → Sort (Sort Key pr.created_at)         total cost ~861549.
--   i.e. it scanned + hashed + sorted the whole table on every 2-minute tick → timeout.
--
-- FIX:
--   Rewrite the anti-join as NOT EXISTS (SELECT 1 FROM public_record_embeddings pre
--   WHERE pre.public_record_id = pr.id). With the existing idx_public_records_created_at
--   index driving the ordered scan, the planner switches to:
--       Nested Loop Anti Join
--         → Index Scan using idx_public_records_created_at on public_records (ordered, no sort)
--         → Index Only Scan using idx_pre_record_id on public_record_embeddings (anti-join probe)
--   and stops after p_limit matches. Prod EXPLAIN: Limit cost 0.85..170.94 for 100 rows
--   (vs 861549 before). The full Seq Scan and the Sort are both gone.
--
--   Contract preserved exactly: same name + signature (p_limit integer DEFAULT 100),
--   same RETURNS TABLE columns and order, same projected columns from public_records,
--   same created_at ASC ordering, same LIMIT p_limit, same LANGUAGE sql / STABLE /
--   SECURITY DEFINER / SET search_path = public, same owner + grants (untouched, so the
--   service-role cron caller keeps EXECUTE). The function had no in-body access guard in
--   the baseline; none is added (this is a service-role-invoked maintenance RPC).
--
-- SUPPORTING INDEX (optional hardening — operator-applied, NON-TRANSACTIONAL):
--   The NOT EXISTS rewrite already fixes the incident using the existing single-column
--   idx_public_records_created_at. A composite (created_at, id) index further hardens the
--   plan as the embedding backlog drains: once the oldest rows are embedded, the ordered
--   scan's leading edge increasingly skips already-embedded rows before collecting p_limit,
--   and (created_at, id) keeps both the ordered walk and the id correlation index-resident,
--   mirroring the existing partial index idx_public_records_unanchored ((created_at) WHERE
--   anchor_id IS NULL). CREATE INDEX CONCURRENTLY cannot run inside the transaction that
--   `supabase db push` wraps migrations in, so — per the 0313 convention — it is documented
--   here for the operator to run STANDALONE, OUTSIDE any transaction. A plain (locking)
--   CREATE INDEX inside this migration would take an ACCESS EXCLUSIVE / SHARE lock on the
--   6.3 GB hot table for the full build and is NOT used here for that reason.
--
--     -- Run standalone, NOT in a transaction, on the live table:
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_records_created_at_id
--       ON public.public_records (created_at, id);
--
--   (If applied, also drop it in rollback with: DROP INDEX CONCURRENTLY IF EXISTS
--   public.idx_public_records_created_at_id; — likewise standalone, outside a txn.)
--
-- ROLLBACK:
--   Restore the baseline definition (the LEFT JOIN public_record_embeddings ... WHERE
--   pre.id IS NULL form) from 00000000000000_baseline_at_main_HEAD.sql, then
--   NOTIFY pgrst, 'reload schema'. If the optional idx_public_records_created_at_id index
--   was created, drop it standalone (see above); the original indexes are untouched by
--   this migration so no other index restore is required.

CREATE OR REPLACE FUNCTION public.get_unembedded_public_records(p_limit integer DEFAULT 100)
    RETURNS TABLE(id uuid, title text, source text, record_type text, metadata jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT pr.id, pr.title, pr.source, pr.record_type, pr.metadata
  FROM public_records pr
  WHERE NOT EXISTS (
    SELECT 1
    FROM public_record_embeddings pre
    WHERE pre.public_record_id = pr.id
  )
  ORDER BY pr.created_at ASC
  LIMIT p_limit;
$$;

ALTER FUNCTION public.get_unembedded_public_records(integer) OWNER TO postgres;

NOTIFY pgrst, 'reload schema';
