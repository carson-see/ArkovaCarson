-- Kept as one top-level DO statement because `supabase db query` rejects
-- multi-statement prepared input. Run only after the standalone concurrent
-- CREATE INDEX statement succeeds.
DO $verify_s33_b1_anchor_index$
DECLARE
  v_index_oid oid := to_regclass('public.s33_rig_b1_anchors_scenario_namespace_status_idx');
  v_anchor_oid oid := to_regclass('public.anchors');
  v_indrelid oid;
  v_indisvalid boolean;
  v_indisready boolean;
  v_indislive boolean;
  v_indisunique boolean;
  v_indnkeyatts smallint;
  v_indnatts smallint;
  v_access_method text;
  v_key_one text;
  v_key_two text;
  v_key_three text;
  v_predicate text;
BEGIN
  IF v_index_oid IS NULL OR v_anchor_oid IS NULL THEN
    RAISE EXCEPTION 'RIG-B1 scenario anchor index or anchors table is absent';
  END IF;

  SELECT i.indrelid, i.indisvalid, i.indisready, i.indislive, i.indisunique,
         i.indnkeyatts, i.indnatts, am.amname,
         regexp_replace(replace(pg_get_indexdef(i.indexrelid, 1, true), '::text', ''),
           '[[:space:]()]', '', 'g'),
         regexp_replace(replace(pg_get_indexdef(i.indexrelid, 2, true), '::text', ''),
           '[[:space:]()]', '', 'g'),
         regexp_replace(replace(pg_get_indexdef(i.indexrelid, 3, true), '::text', ''),
           '[[:space:]()]', '', 'g'),
         regexp_replace(replace(pg_get_expr(i.indpred, i.indrelid, true), '::text', ''),
           '[[:space:]()]', '', 'g')
  INTO v_indrelid, v_indisvalid, v_indisready, v_indislive, v_indisunique,
       v_indnkeyatts, v_indnatts, v_access_method,
       v_key_one, v_key_two, v_key_three, v_predicate
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class index_class ON index_class.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_class.relnamespace
  JOIN pg_catalog.pg_am am ON am.oid = index_class.relam
  WHERE i.indexrelid = v_index_oid
    AND index_namespace.nspname = 'public'
    AND index_class.relname = 's33_rig_b1_anchors_scenario_namespace_status_idx';

  IF NOT FOUND
    OR v_indrelid <> v_anchor_oid
    OR v_indisvalid IS DISTINCT FROM true
    OR v_indisready IS DISTINCT FROM true
    OR v_indislive IS DISTINCT FROM true
    OR v_indisunique IS DISTINCT FROM false
    OR v_indnkeyatts <> 3
    OR v_indnatts <> 3
    OR v_access_method <> 'btree'
    OR v_key_one <> $expected$metadata->'s33_rig_b1'->>'scenarioLeaseId'$expected$
    OR v_key_two <> $expected$metadata->'s33_rig_b1'->>'namespaceId'$expected$
    OR v_key_three <> 'status'
    OR v_predicate <> $expected$deleted_atISNULLANDmetadata?'s33_rig_b1'$expected$ THEN
    RAISE EXCEPTION 'RIG-B1 scenario anchor index failed exact validity, key, or predicate verification';
  END IF;
END;
$verify_s33_b1_anchor_index$;
