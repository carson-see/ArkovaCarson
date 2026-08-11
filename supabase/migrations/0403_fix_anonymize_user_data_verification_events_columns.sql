-- 0403 — fix: GDPR Art. 17 right-to-erasure aborted on non-existent columns
--
-- CONFIRMED PROD BUG (project vzwyaatejekddvltxyye, verified 2026-08-10 via
-- pg_get_functiondef + information_schema). delete_own_account() and the
-- worker's DELETE /api/account both call anonymize_user_data(p_user_id). That
-- SECURITY DEFINER function ended with:
--
--     UPDATE verification_events SET details = NULL
--     WHERE user_id = p_user_id AND details IS NOT NULL;
--
-- public.verification_events is a PII-free public-lookup ANALYTICS table.
-- Its real column set (baseline pg_dump) is:
--     id, anchor_id, public_id, method, result, fingerprint_provided,
--     ip_hash, user_agent, referrer, country_code, org_id, created_at
-- It has NO "user_id" column and NO "details" column — those were never in
-- the prod schema. So the statement raised SQLSTATE 42703 (undefined_column)
-- at runtime and aborted the ENTIRE anonymization transaction. Every
-- account-deletion erasure failed: no PII was scrubbed and the profile was
-- never soft-deleted. The only prior coverage MOCKED the RPC
-- (services/worker/src/api/account-delete.test.ts) plus a SQL-existence check
-- that never validated column references — which is why the defect shipped.
--
-- FIX (compensating migration — the baseline is immutable per CLAUDE.md §1.2):
--   1. Drop the verification_events UPDATE. That analytics table holds no
--      personal data about the erased SUBJECT: it logs public verification
--      lookups performed by third parties, and its only near-PII field,
--      ip_hash, is a hash of the *verifier's* IP on a public request, not the
--      subject's. Expressed against the columns that actually exist, the
--      correct erasure action for this table is a no-op — v_verification_count
--      stays 0. (The only table carrying both user_id AND details is
--      data_subject_requests, the GDPR request audit log, which must be
--      RETAINED, not scrubbed. Re-pointing the UPDATE anywhere would be scope
--      creep; there is genuinely nothing to erase here.)
--   2. Complete the ai_usage_events scrub the function already performs: null
--      BOTH fingerprint AND result_json for the subject. result_json is
--      documented as "Cached extraction result fields" — i.e. the extracted
--      contents of the user's documents, the same document-derived PII class
--      the original fingerprint null-out was protecting. Nulling only
--      fingerprint left that cached PII behind in a table the function already
--      covers. Scoped WHERE user_id = p_user_id, so no other user's rows are
--      touched; once fingerprint is null the EFF-1 cache-by-fingerprint lookup
--      (idx_ai_usage_events_cache_lookup, WHERE result_json IS NOT NULL) can
--      no longer hit these rows anyway. (error_message is deliberately left
--      as-is: per §1.6A the error surfaces are policy-bound not to carry raw
--      PII, and nulling it is not part of this table's established scrub.)
--
-- Authorization is UNCHANGED and re-asserted: service_role-only guard
-- (auth.role() != 'service_role' -> insufficient_privilege), p_user_id NULL
-- guard, SECURITY DEFINER + SET search_path = public, and REVOKE ALL FROM
-- PUBLIC + GRANT EXECUTE TO service_role (preserved across CREATE OR REPLACE;
-- re-issued here so the posture is auditable in-migration). No signature
-- change, so no database.types.ts delta.
--
-- Tier T3 (touches supabase/migrations/). NOT applied to prod or any rig by
-- this change — file only.
--
-- ROLLBACK: CREATE OR REPLACE public.anonymize_user_data(uuid) with the
-- baseline body verbatim (see the anonymize_user_data definition in
-- 00000000000000_baseline_at_main_HEAD.sql). NOTE: rolling back reintroduces
-- the 42703-on-erasure bug this migration fixes — do so only to revert schema
-- state, never to "keep" the old behavior.

CREATE OR REPLACE FUNCTION public.anonymize_user_data(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_audit_count integer := 0;
  v_ai_usage_count integer := 0;
  -- verification_events is PII-free public-lookup analytics with no
  -- subject-linked column (no user_id, no details) -> always 0.
  v_verification_count integer := 0;
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can anonymize user data'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COUNT(*) INTO v_audit_count
  FROM audit_events WHERE actor_id = p_user_id;

  -- Scrub document-derived PII cached in ai_usage_events for this subject:
  -- both the document fingerprint and the cached extracted result fields.
  UPDATE ai_usage_events
  SET fingerprint = NULL,
      result_json = NULL
  WHERE user_id = p_user_id
    AND (fingerprint IS NOT NULL OR result_json IS NOT NULL);
  GET DIAGNOSTICS v_ai_usage_count = ROW_COUNT;

  -- (No verification_events write: that analytics table carries no personal
  --  data about the erased subject. See the header for the full rationale.)

  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, details)
  VALUES ('user.data_anonymized', 'SYSTEM', NULL, NULL,
    'GDPR Art. 17 erasure: counted ' || v_audit_count || ' audit, '
    || 'anonymized ' || v_ai_usage_count || ' AI usage, '
    || v_verification_count || ' verification events for user ' || p_user_id);

  RETURN jsonb_build_object(
    'success', true, 'user_id', p_user_id,
    'audit_events_affected', v_audit_count,
    'ai_usage_events_anonymized', v_ai_usage_count,
    'verification_events_anonymized', v_verification_count);
END;
$$;

REVOKE ALL ON FUNCTION public.anonymize_user_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anonymize_user_data(uuid) TO service_role;

-- Body-only change (signature unchanged), but reload the PostgREST schema
-- cache per the CLAUDE.md §6 convention for function redefinitions.
NOTIFY pgrst, 'reload schema';
