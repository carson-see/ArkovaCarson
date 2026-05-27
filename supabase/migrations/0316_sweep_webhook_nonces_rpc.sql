-- SCRUM-2040: RPC to sweep expired webhook nonces (SOC 2 CC7.4).
--
-- Deletes rows older than `retention_days` from the specified nonce table.
-- Returns the count of deleted rows. Callable only by service_role (worker).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.sweep_webhook_nonces(TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.sweep_webhook_nonces(
  target_table TEXT,
  retention_days INTEGER DEFAULT 14
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allowed_tables TEXT[] := ARRAY[
    'docusign_webhook_nonces',
    'drive_webhook_nonces',
    'ats_webhook_nonces',
    'microsoft_graph_webhook_nonces'
  ];
  deleted_count INTEGER;
BEGIN
  IF target_table != ALL(allowed_tables) THEN
    RAISE EXCEPTION 'sweep_webhook_nonces: table "%" not in allowlist', target_table;
  END IF;

  IF retention_days < 1 OR retention_days > 365 THEN
    RAISE EXCEPTION 'sweep_webhook_nonces: retention_days must be 1-365, got %', retention_days;
  END IF;

  EXECUTE format(
    'DELETE FROM %I WHERE received_at < NOW() - make_interval(days => $1)',
    target_table
  ) USING retention_days;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.sweep_webhook_nonces IS
  'SCRUM-2040: deletes webhook nonces older than retention_days from the named table. Allowlisted tables only.';

NOTIFY pgrst, 'reload schema';
