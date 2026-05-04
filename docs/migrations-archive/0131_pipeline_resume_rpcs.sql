-- Migration: Pipeline resume helper RPCs for date-based and shard-based auto-resume
-- Enables fetchers to skip already-ingested date ranges / shards
-- ROLLBACK: DROP FUNCTION IF EXISTS get_source_date_range(text, text); DROP FUNCTION IF EXISTS get_edgar_shard_counts();

-- Generic date range helper: returns min/max date + count for a source
CREATE OR REPLACE FUNCTION get_source_date_range(
  p_source text,
  p_date_field text DEFAULT 'date_filed'
)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'min_date', MIN(metadata->>p_date_field),
    'max_date', MAX(metadata->>p_date_field),
    'count', COUNT(*)
  )
  FROM public_records
  WHERE source = p_source;
$$;

-- EDGAR shard counts: form_type × year → count for skip-ahead resume
CREATE OR REPLACE FUNCTION get_edgar_shard_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT
      metadata->>'form_type' as form_type,
      EXTRACT(YEAR FROM (metadata->>'filing_date')::date)::int as filing_year,
      COUNT(*) as cnt
    FROM public_records
    WHERE source = 'edgar'
      AND metadata->>'form_type' IS NOT NULL
      AND metadata->>'filing_date' IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) >= 10
  ) t;
$$;
