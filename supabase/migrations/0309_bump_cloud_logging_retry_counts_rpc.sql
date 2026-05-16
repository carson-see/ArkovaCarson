-- SCRUM-1296: Bulk retry-count bump for cloud_logging_queue.
-- Replaces N read-modify-write round-trips with a single SQL statement.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS bump_cloud_logging_retry_counts;

CREATE OR REPLACE FUNCTION bump_cloud_logging_retry_counts(
  p_audit_ids text[],
  p_error_msg text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE cloud_logging_queue
  SET
    retry_count = LEAST(retry_count + 1, 99),
    last_error = COALESCE(p_error_msg, last_error)
  WHERE audit_id = ANY(p_audit_ids);
END;
$$;
