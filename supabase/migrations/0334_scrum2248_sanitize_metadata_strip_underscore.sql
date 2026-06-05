-- SCRUM-2248 (HARDEN-1-E) — BUG-2026-06-05-001 (SEV1): anon anchor metadata leak.
--
-- WHY: get_public_anchor is GRANTed to anon and is called directly by the public
-- verification page (src/components/verification/PublicVerification.tsx and
-- src/components/embed/VerificationWidget.tsx) via the Supabase anon client. It
-- returns the freeform anchors.metadata blob through sanitize_metadata_for_public.
-- That helper was a pure DENYLIST: it strips a fixed set of NAMED PII keys
-- (recipient, email, ssn, ...), but it does NOT strip the `_`-prefixed
-- worker/chain internals the anchoring pipeline stamps onto metadata. As a result
-- `_raw_tx_hex` (the FULL signed Bitcoin transaction hex), `_fee_sats`,
-- `_metadata_hash`, and any other `_`-prefixed internal leak to ANONYMOUS callers.
--
-- FIX (defense in depth, §1.4): redefine sanitize_metadata_for_public to ALSO
-- strip EVERY top-level key whose name starts with an underscore. This is a
-- prefix denylist on a reserved namespace — the worker owns the `_` prefix for
-- internal-only fields — so it also covers any FUTURE `_`-prefixed internal
-- without another migration. The existing named PII denylist is kept as a first
-- pass (belt and suspenders): named PII that does not start with `_` is still
-- removed even though it is not underscore-prefixed.
--
-- This is a PURE FUNCTION-BODY redefinition. No schema change, no data migration,
-- no signature change, no grant change. The two callers of this helper are both
-- public-display paths (get_public_anchor in 0331 / the baseline), so stripping
-- the worker `_` namespace is correct and consistent for both. Per §1.8 this is
-- a tightening of an existing nullable freeform field, not a contract break.
--
-- ROLLBACK: restore the prior (denylist-only) sanitize_metadata_for_public body,
-- which is the definition captured from 00000000000000_baseline_at_main_HEAD.sql
-- (the immediately prior definition of this function). It omits the underscore
-- strip. No data migration is involved; this is a pure function redefinition.
-- After rollback also run: NOTIFY pgrst, 'reload schema';
--
--   CREATE OR REPLACE FUNCTION public.sanitize_metadata_for_public(p_metadata jsonb)
--     RETURNS jsonb
--     LANGUAGE sql IMMUTABLE
--     SET search_path TO 'public'
--     AS $rollback$
--     SELECT COALESCE(
--       p_metadata
--         - 'recipient'
--         - 'email'
--         - 'phone'
--         - 'phone_number'
--         - 'ssn'
--         - 'social_security'
--         - 'student_id'
--         - 'student_number'
--         - 'address'
--         - 'street_address'
--         - 'home_address'
--         - 'mailing_address'
--         - 'dob'
--         - 'date_of_birth'
--         - 'birthday'
--         - 'national_id'
--         - 'passport_number'
--         - 'drivers_license',
--       '{}'::jsonb
--     );
--   $rollback$;
--   NOTIFY pgrst, 'reload schema';

CREATE OR REPLACE FUNCTION public.sanitize_metadata_for_public(p_metadata jsonb)
  RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path TO 'public'
  AS $$
  -- Step 1: named PII denylist (defense in depth — unchanged from prior body).
  -- Step 2: drop EVERY remaining top-level key starting with '_' (worker/chain
  --   internal namespace, e.g. _raw_tx_hex / _fee_sats / _metadata_hash). The
  --   underscore in the LIKE pattern is escaped (\_) so it matches a literal
  --   leading underscore, not the LIKE single-char wildcard.
  SELECT COALESCE(
    (
      SELECT jsonb_object_agg(kv.key, kv.value)
      FROM jsonb_each(
        COALESCE(p_metadata, '{}'::jsonb)
          - 'recipient'
          - 'email'
          - 'phone'
          - 'phone_number'
          - 'ssn'
          - 'social_security'
          - 'student_id'
          - 'student_number'
          - 'address'
          - 'street_address'
          - 'home_address'
          - 'mailing_address'
          - 'dob'
          - 'date_of_birth'
          - 'birthday'
          - 'national_id'
          - 'passport_number'
          - 'drivers_license'
      ) AS kv(key, value)
      WHERE kv.key NOT LIKE '\_%'
    ),
    '{}'::jsonb
  );
$$;

NOTIFY pgrst, 'reload schema';
