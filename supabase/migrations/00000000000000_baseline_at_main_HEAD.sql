-- =============================================================================
-- BASELINE: Arkova prod schema snapshot at main HEAD 30e56792 on 2026-05-04.
--
-- Generation: `npx supabase db dump --linked --schema public` against prod
-- (project_ref vzwyaatejekddvltxyye), executed via local pg_dump 17 with the
-- Supabase CLI's idempotency sed pipeline applied (CREATE TABLE → CREATE TABLE
-- IF NOT EXISTS, CREATE FUNCTION → CREATE OR REPLACE FUNCTION, etc.). NOT a
-- reconstruction — this is byte-faithful pg_dump output of the live schema.
--
-- Purpose: replaces the historical 0001..0289 migration replay-from-zero on
-- every fresh DB stand-up (preview branches, CLI bootstrap, npx supabase db
-- reset). Migrations 0291+ continue to apply on top exactly as today.
--
-- 14-digit zero-timestamp prefix matches the Supabase preview-branch builder
-- regex `^(\d{14}|\d{1,4})_` natively, and lexicographically sorts before all
-- real migrations. Sidesteps the lettered-suffix preview-branch incompatibility
-- (PR #691's 0055b_*) and the 0055/0056 fresh-DB ordering bug.
--
-- Subsumes / deprecates:
--   - 0000..0289 historical migration chain (archived to docs/migrations-archive/)
--   - 0055b_seed_alignment_idempotent.sql (PR #691 CLI bridge)
--   - 0290_suborg_suspension_audit_and_service_role_fix.sql (folded in;
--     coordinate with PR #697 to drop or rebase as 0291).
--
-- ROLLBACK: this baseline is destructive on cutover. Recovery is to revert the
-- ledger INSERT in supabase_migrations.schema_migrations and restore the repo
-- to 0000..0289 + 0290 + ... layout. Schema itself is unchanged through
-- cutover (metadata-only operation on prod). See PATH_C_CUTOVER.md §4.
--
-- Verified 2026-05-04 against branch project_ref aljheljcsrgbtgyshfss (off
-- staging ujtlwnoqfhtitcmsnrpq). Schema-object diff vs prod: 11/13 categories
-- identical (94 tables, 5 views, 2 matviews, 28 enums, 1 sequence, 328
-- functions, 189 policies, 94 RLS-enabled+forced, 44 triggers, 418
-- constraints). Only diffs: 3 invalid indexes excluded by pg_dump (failed
-- CREATE INDEX CONCURRENTLY on prod, pg_index.indisvalid=false — tech debt
-- not load-bearing); pg_repack extension added explicitly below since the
-- CLI dump pipeline strips CREATE EXTENSION (Supabase manages extensions
-- per-project but for fresh stand-ups we install them ourselves).
-- =============================================================================


-- Extensions (the supabase db dump CLI strips CREATE EXTENSION; we restore
-- them explicitly so a fresh DB stand-up via this baseline alone is functional).
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS moddatetime;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_repack;
CREATE EXTENSION IF NOT EXISTS http;
CREATE EXTENSION IF NOT EXISTS hypopg;
CREATE EXTENSION IF NOT EXISTS index_advisor;
CREATE EXTENSION IF NOT EXISTS supabase_vault;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS plpgsql;


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."agent_status" AS ENUM (
    'active',
    'suspended',
    'revoked'
);


ALTER TYPE "public"."agent_status" OWNER TO "postgres";


CREATE TYPE "public"."agent_type" AS ENUM (
    'llm_agent',
    'ats_integration',
    'hr_platform',
    'compliance_tool',
    'custom'
);


ALTER TYPE "public"."agent_type" OWNER TO "postgres";


CREATE TYPE "public"."ai_report_status" AS ENUM (
    'QUEUED',
    'GENERATING',
    'COMPLETE',
    'FAILED'
);


ALTER TYPE "public"."ai_report_status" OWNER TO "postgres";


CREATE TYPE "public"."anchor_status" AS ENUM (
    'PENDING',
    'SECURED',
    'REVOKED',
    'EXPIRED',
    'SUBMITTED',
    'BROADCASTING',
    'SUPERSEDED',
    'PENDING_RESOLUTION'
);


ALTER TYPE "public"."anchor_status" OWNER TO "postgres";


CREATE TYPE "public"."api_key_rate_limit_tier" AS ENUM (
    'free',
    'paid',
    'custom'
);


ALTER TYPE "public"."api_key_rate_limit_tier" OWNER TO "postgres";


CREATE TYPE "public"."attestation_status" AS ENUM (
    'DRAFT',
    'PENDING',
    'ACTIVE',
    'REVOKED',
    'EXPIRED',
    'CHALLENGED'
);


ALTER TYPE "public"."attestation_status" OWNER TO "postgres";


CREATE TYPE "public"."attestation_type" AS ENUM (
    'VERIFICATION',
    'ENDORSEMENT',
    'AUDIT',
    'APPROVAL',
    'WITNESS',
    'COMPLIANCE',
    'SUPPLY_CHAIN',
    'IDENTITY',
    'CUSTOM'
);


ALTER TYPE "public"."attestation_type" OWNER TO "postgres";


CREATE TYPE "public"."attester_type" AS ENUM (
    'INSTITUTION',
    'CORPORATION',
    'INDIVIDUAL',
    'REGULATORY',
    'THIRD_PARTY'
);


ALTER TYPE "public"."attester_type" OWNER TO "postgres";


CREATE TYPE "public"."credential_type" AS ENUM (
    'DEGREE',
    'LICENSE',
    'CERTIFICATE',
    'TRANSCRIPT',
    'PROFESSIONAL',
    'OTHER',
    'CLE',
    'SEC_FILING',
    'PATENT',
    'REGULATION',
    'PUBLICATION',
    'BADGE',
    'ATTESTATION',
    'FINANCIAL',
    'LEGAL',
    'INSURANCE',
    'CHARITY',
    'FINANCIAL_ADVISOR',
    'BUSINESS_ENTITY',
    'RESUME',
    'MEDICAL',
    'MILITARY',
    'IDENTITY',
    'ACCREDITATION',
    'CONTRACT_PRESIGNING',
    'CONTRACT_POSTSIGNING'
);


ALTER TYPE "public"."credential_type" OWNER TO "postgres";


COMMENT ON TYPE "public"."credential_type" IS 'Classification of anchored credential documents. CLE = Continuing Legal Education credit.';



CREATE TYPE "public"."credit_transaction_type" AS ENUM (
    'ALLOCATION',
    'PURCHASE',
    'DEDUCTION',
    'EXPIRY',
    'REFUND'
);


ALTER TYPE "public"."credit_transaction_type" OWNER TO "postgres";


CREATE TYPE "public"."ferpa_exception_category" AS ENUM (
    '99.31(a)(1)',
    '99.31(a)(2)',
    '99.31(a)(3)',
    '99.31(a)(4)',
    '99.31(a)(5)',
    '99.31(a)(6)',
    '99.31(a)(7)',
    '99.31(a)(8)',
    '99.31(a)(9)',
    '99.31(a)(10)',
    '99.31(a)(11)',
    '99.31(a)(12)',
    'other'
);


ALTER TYPE "public"."ferpa_exception_category" OWNER TO "postgres";


CREATE TYPE "public"."ferpa_party_type" AS ENUM (
    'school_official',
    'employer',
    'government',
    'accreditor',
    'financial_aid',
    'research',
    'health_safety',
    'subpoena',
    'directory_info',
    'other'
);


ALTER TYPE "public"."ferpa_party_type" OWNER TO "postgres";


CREATE TYPE "public"."grc_platform" AS ENUM (
    'vanta',
    'drata',
    'anecdotes'
);


ALTER TYPE "public"."grc_platform" OWNER TO "postgres";


CREATE TYPE "public"."grc_sync_status" AS ENUM (
    'pending',
    'syncing',
    'success',
    'failed'
);


ALTER TYPE "public"."grc_sync_status" OWNER TO "postgres";


CREATE TYPE "public"."integrity_level" AS ENUM (
    'HIGH',
    'MEDIUM',
    'LOW',
    'FLAGGED'
);


ALTER TYPE "public"."integrity_level" OWNER TO "postgres";


CREATE TYPE "public"."notification_type" AS ENUM (
    'queue_run_completed',
    'rule_fired',
    'version_available_for_review',
    'treasury_alert',
    'anchor_revoked'
);


ALTER TYPE "public"."notification_type" OWNER TO "postgres";


CREATE TYPE "public"."org_member_role" AS ENUM (
    'owner',
    'admin',
    'member',
    'compliance_officer'
);


ALTER TYPE "public"."org_member_role" OWNER TO "postgres";


COMMENT ON TYPE "public"."org_member_role" IS 'owner = created the org, admin = can manage members/settings, member = can view records, compliance_officer = can view compliance data and export proofs';



CREATE TYPE "public"."org_rule_action_type" AS ENUM (
    'AUTO_ANCHOR',
    'FAST_TRACK_ANCHOR',
    'QUEUE_FOR_REVIEW',
    'FLAG_COLLISION',
    'NOTIFY',
    'FORWARD_TO_URL'
);


ALTER TYPE "public"."org_rule_action_type" OWNER TO "postgres";


CREATE TYPE "public"."org_rule_event_status" AS ENUM (
    'PENDING',
    'CLAIMED',
    'PROCESSED',
    'FAILED'
);


ALTER TYPE "public"."org_rule_event_status" OWNER TO "postgres";


CREATE TYPE "public"."org_rule_execution_status" AS ENUM (
    'PENDING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'RETRYING',
    'DLQ'
);


ALTER TYPE "public"."org_rule_execution_status" OWNER TO "postgres";


CREATE TYPE "public"."org_rule_trigger_type" AS ENUM (
    'ESIGN_COMPLETED',
    'WORKSPACE_FILE_MODIFIED',
    'CONNECTOR_DOCUMENT_RECEIVED',
    'MANUAL_UPLOAD',
    'SCHEDULED_CRON',
    'QUEUE_DIGEST',
    'EMAIL_INTAKE'
);


ALTER TYPE "public"."org_rule_trigger_type" OWNER TO "postgres";


CREATE TYPE "public"."org_tier" AS ENUM (
    'FREE',
    'PAID',
    'ENTERPRISE',
    'SMALL_BUSINESS',
    'MEDIUM_BUSINESS'
);


ALTER TYPE "public"."org_tier" OWNER TO "postgres";


CREATE TYPE "public"."profile_status" AS ENUM (
    'ACTIVE',
    'PENDING_ACTIVATION',
    'DEACTIVATED'
);


ALTER TYPE "public"."profile_status" OWNER TO "postgres";


CREATE TYPE "public"."report_status" AS ENUM (
    'pending',
    'generating',
    'completed',
    'failed'
);


ALTER TYPE "public"."report_status" OWNER TO "postgres";


CREATE TYPE "public"."report_type" AS ENUM (
    'anchor_summary',
    'compliance_audit',
    'activity_log',
    'billing_history'
);


ALTER TYPE "public"."report_type" OWNER TO "postgres";


CREATE TYPE "public"."review_action" AS ENUM (
    'APPROVE',
    'INVESTIGATE',
    'ESCALATE',
    'DISMISS'
);


ALTER TYPE "public"."review_action" OWNER TO "postgres";


CREATE TYPE "public"."review_status" AS ENUM (
    'PENDING',
    'APPROVED',
    'INVESTIGATING',
    'ESCALATED',
    'DISMISSED'
);


ALTER TYPE "public"."review_status" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'INDIVIDUAL',
    'ORG_ADMIN',
    'ORG_MEMBER'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."activate_user"("p_token" "text", "p_password" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  pending_profile RECORD;
BEGIN
  -- Look up the pending profile by activation token
  SELECT * INTO pending_profile
  FROM profiles
  WHERE activation_token = p_token
    AND status = 'PENDING_ACTIVATION';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired activation token');
  END IF;

  -- Check if token has expired
  IF pending_profile.activation_token_expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Activation token has expired. Please contact your organization administrator.');
  END IF;

  -- Activate the profile: clear token, set status to ACTIVE
  UPDATE profiles
  SET status = 'ACTIVE',
      activation_token = NULL,
      activation_token_expires_at = NULL,
      updated_at = now()
  WHERE id = pending_profile.id;

  -- Audit event
  INSERT INTO audit_events (
    event_type,
    event_category,
    actor_id,
    org_id,
    target_type,
    target_id,
    details
  ) VALUES (
    'USER_ACTIVATED',
    'USER',
    pending_profile.id,
    pending_profile.org_id,
    'profile',
    pending_profile.id::text,
    jsonb_build_object('email', pending_profile.email)::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'email', pending_profile.email,
    'profile_id', pending_profile.id
  );
END;
$$;


ALTER FUNCTION "public"."activate_user"("p_token" "text", "p_password" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_change_user_role"("p_user_id" "uuid", "p_new_role" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  IF p_new_role NOT IN ('INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER') THEN
    RAISE EXCEPTION 'Invalid role: %. Must be INDIVIDUAL, ORG_ADMIN, or ORG_MEMBER', p_new_role;
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;
  UPDATE profiles SET role = p_new_role::user_role, updated_at = now() WHERE id = p_user_id;
  ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
    ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;


ALTER FUNCTION "public"."admin_change_user_role"("p_user_id" "uuid", "p_new_role" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_change_user_role"("p_user_id" "uuid", "p_new_role" "text") IS 'Change user role. Bypasses immutability trigger. Service role only. Auth guard: service_role check (0160).';



CREATE OR REPLACE FUNCTION "public"."admin_set_platform_admin"("p_user_id" "uuid", "p_is_admin" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER trg_protect_platform_admin;
  UPDATE profiles SET is_platform_admin = p_is_admin, updated_at = now() WHERE id = p_user_id;
  ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;


ALTER FUNCTION "public"."admin_set_platform_admin"("p_user_id" "uuid", "p_is_admin" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_set_platform_admin"("p_user_id" "uuid", "p_is_admin" boolean) IS 'Toggle is_platform_admin flag. Bypasses protective trigger. Service role only. Auth guard: service_role check (0160).';



CREATE OR REPLACE FUNCTION "public"."admin_set_user_org"("p_user_id" "uuid", "p_org_id" "uuid", "p_org_role" "text" DEFAULT 'member'::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied: service_role required';
  END IF;

  IF p_org_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Invalid org_role: %. Must be owner, admin, or member', p_org_role;
  END IF;

  IF p_org_id IS NOT NULL THEN
    PERFORM 1 FROM organizations WHERE id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Organization not found: %', p_org_id;
    END IF;
  END IF;

  ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;
  UPDATE profiles SET org_id = p_org_id, updated_at = now() WHERE id = p_user_id;
  ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  IF p_org_id IS NOT NULL THEN
    INSERT INTO org_members (user_id, org_id, role)
    VALUES (p_user_id, p_org_id, p_org_role::org_member_role)
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = p_org_role::org_member_role;
  ELSE
    DELETE FROM org_members WHERE user_id = p_user_id;
  END IF;
END;
$$;


ALTER FUNCTION "public"."admin_set_user_org"("p_user_id" "uuid", "p_org_id" "uuid", "p_org_role" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_set_user_org"("p_user_id" "uuid", "p_org_id" "uuid", "p_org_role" "text") IS 'Set user organization and org_members role. Bypasses protective triggers. Service role only. Auth guard: service_role check (0160).';



CREATE OR REPLACE FUNCTION "public"."allocate_credits_to_sub_org"("p_parent_org_id" "uuid", "p_child_org_id" "uuid", "p_amount" integer, "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller         uuid := auth.uid();
  v_parent_balance integer;
  v_child_balance  integer;
  v_actual_parent  uuid;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT parent_org_id INTO v_actual_parent FROM organizations WHERE id = p_child_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('error', 'not_a_sub_org');
  END IF;

  PERFORM 1 FROM org_credits WHERE org_id = LEAST(p_parent_org_id, p_child_org_id) FOR UPDATE;
  PERFORM 1 FROM org_credits WHERE org_id = GREATEST(p_parent_org_id, p_child_org_id) FOR UPDATE;

  INSERT INTO org_credits (org_id) VALUES (p_parent_org_id) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO org_credits (org_id) VALUES (p_child_org_id)  ON CONFLICT (org_id) DO NOTHING;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id FOR UPDATE;

  IF p_amount > 0 AND v_parent_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_parent_balance',
      'parent_balance', v_parent_balance,
      'requested', p_amount
    );
  END IF;

  IF p_amount < 0 THEN
    SELECT balance INTO v_child_balance FROM org_credits WHERE org_id = p_child_org_id FOR UPDATE;
    IF v_child_balance < ABS(p_amount) THEN
      RETURN jsonb_build_object(
        'error', 'insufficient_child_balance',
        'child_balance', v_child_balance,
        'requested', p_amount
      );
    END IF;
  END IF;

  UPDATE org_credits SET balance = balance - p_amount, updated_at = now() WHERE org_id = p_parent_org_id;
  UPDATE org_credits SET balance = balance + p_amount, updated_at = now() WHERE org_id = p_child_org_id;

  INSERT INTO org_credit_allocations (parent_org_id, child_org_id, amount, granted_by, note)
  VALUES (p_parent_org_id, p_child_org_id, p_amount, v_caller, p_note);

  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, org_id, details
  ) VALUES (
    'ORG_CREDIT_ALLOCATED', 'ORG', v_caller, 'organization', p_child_org_id::text, p_parent_org_id,
    json_build_object(
      'amount', p_amount,
      'parent_org_id', p_parent_org_id,
      'child_org_id', p_child_org_id,
      'note', p_note
    )::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'parent_balance', v_parent_balance - p_amount,
    'child_balance', (SELECT balance FROM org_credits WHERE org_id = p_child_org_id)
  );
END;
$$;


ALTER FUNCTION "public"."allocate_credits_to_sub_org"("p_parent_org_id" "uuid", "p_child_org_id" "uuid", "p_amount" integer, "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."allocate_monthly_credits"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count integer := 0;
  v_record RECORD;
  v_plan_allocation integer;
  v_expired_monthly integer;
BEGIN
  FOR v_record IN
    SELECT c.*, s.plan_id, p.name as plan_name
    FROM credits c
    LEFT JOIN subscriptions s ON s.user_id = c.user_id AND s.status IN ('active', 'trialing')
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE c.cycle_end <= now()
  LOOP
    v_plan_allocation := CASE v_record.plan_name
      WHEN 'Individual' THEN 500
      WHEN 'Professional' THEN 5000
      ELSE 50
    END;

    v_expired_monthly := GREATEST(0, v_record.balance - v_record.purchased);

    IF v_expired_monthly > 0 THEN
      INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
      VALUES (v_record.user_id, 'EXPIRY', -v_expired_monthly,
              v_record.purchased, 'Monthly credits expired');
    END IF;

    UPDATE credits SET
      balance = v_record.purchased + v_plan_allocation,
      monthly_allocation = v_plan_allocation,
      cycle_start = date_trunc('month', now()),
      cycle_end = date_trunc('month', now()) + interval '1 month',
      updated_at = now()
    WHERE id = v_record.id;

    INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
    VALUES (v_record.user_id, 'ALLOCATION', v_plan_allocation,
            v_record.purchased + v_plan_allocation, 'Monthly credit allocation');

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."allocate_monthly_credits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."anonymize_member_display_name"("p_full_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
DECLARE
  parts text[];
  initial text;
  last_name text;
BEGIN
  IF p_full_name IS NULL OR length(trim(p_full_name)) = 0 THEN
    RETURN 'Anonymous member';
  END IF;
  parts := regexp_split_to_array(trim(p_full_name), '\s+');
  IF array_length(parts, 1) < 2 THEN
    RETURN 'Anonymous member';
  END IF;
  initial := upper(left(parts[1], 1));
  last_name := parts[array_length(parts, 1)];
  RETURN initial || '. ' || last_name;
END;
$$;


ALTER FUNCTION "public"."anonymize_member_display_name"("p_full_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."anonymize_user_data"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_audit_count integer := 0;
  v_ai_usage_count integer := 0;
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

  UPDATE ai_usage_events SET fingerprint = NULL
  WHERE user_id = p_user_id AND fingerprint IS NOT NULL;
  GET DIAGNOSTICS v_ai_usage_count = ROW_COUNT;

  UPDATE verification_events SET details = NULL
  WHERE user_id = p_user_id AND details IS NOT NULL;
  GET DIAGNOSTICS v_verification_count = ROW_COUNT;

  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, details)
  VALUES ('user.data_anonymized', 'SYSTEM', NULL, NULL,
    'GDPR Art. 17 erasure: anonymized ' || v_audit_count || ' audit, '
    || v_ai_usage_count || ' AI usage, '
    || v_verification_count || ' verification events for user ' || p_user_id);

  RETURN jsonb_build_object(
    'success', true, 'user_id', p_user_id,
    'audit_events_affected', v_audit_count,
    'ai_usage_events_anonymized', v_ai_usage_count,
    'verification_events_anonymized', v_verification_count);
END;
$$;


ALTER FUNCTION "public"."anonymize_user_data"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."archive_old_audit_events"("retention_days" integer DEFAULT 90) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  cutoff timestamptz;
  archived_count integer;
BEGIN
  cutoff := now() - (retention_days || ' days')::interval;
  WITH moved AS (
    DELETE FROM audit_events
    WHERE created_at < cutoff
    RETURNING *
  )
  INSERT INTO audit_events_archive
  SELECT * FROM moved;
  GET DIAGNOSTICS archived_count = ROW_COUNT;
  RETURN archived_count;
END;
$$;


ALTER FUNCTION "public"."archive_old_audit_events"("retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_associate_profile_to_org_by_email_domain"("p_user_id" "uuid", "p_email" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
DECLARE
  v_domain text;
  v_org_id uuid;
  v_org_name text;
  v_profile_exists boolean;
  v_membership_count integer;
BEGIN
  IF p_user_id IS NULL OR p_email IS NULL OR position('@' in p_email) = 0 THEN
    RETURN NULL;
  END IF;

  v_domain := lower(split_part(p_email, '@', 2));
  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN NULL;
  END IF;

  SELECT id, display_name
  INTO v_org_id, v_org_name
  FROM organizations
  WHERE lower(domain) = v_domain
  ORDER BY
    COALESCE(domain_verified, false) DESC,
    CASE verification_status
      WHEN 'VERIFIED' THEN 0
      WHEN 'PENDING' THEN 1
      ELSE 2
    END,
    created_at ASC
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  INSERT INTO org_members (user_id, org_id, role)
  VALUES (p_user_id, v_org_id, 'member')
  ON CONFLICT (user_id, org_id) DO NOTHING;
  GET DIAGNOSTICS v_membership_count = ROW_COUNT;

  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id)
  INTO v_profile_exists;

  IF v_profile_exists THEN
    UPDATE profiles
    SET
      org_id = COALESCE(org_id, v_org_id),
      role = COALESCE(role, 'ORG_MEMBER'::user_role),
      role_set_at = CASE WHEN role IS NULL THEN now() ELSE role_set_at END
    WHERE id = p_user_id
      AND (org_id IS NULL OR role IS NULL);

    IF v_membership_count > 0 THEN
      INSERT INTO audit_events (
        event_type,
        event_category,
        actor_id,
        target_type,
        target_id,
        org_id,
        details
      ) VALUES (
        'profile.org_auto_associated',
        'PROFILE',
        p_user_id,
        'profile',
        p_user_id,
        v_org_id,
        format('Auto-associated %s to %s by verified email domain %s', p_email, v_org_name, v_domain)
      );
    END IF;
  END IF;

  RETURN v_org_id;
END;
$$;


ALTER FUNCTION "public"."auto_associate_profile_to_org_by_email_domain"("p_user_id" "uuid", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."auto_associate_profile_to_org_by_email_domain"("p_user_id" "uuid", "p_email" "text") IS 'Adds a verified-email user to an organization whose domain matches their email domain.';



CREATE OR REPLACE FUNCTION "public"."auto_generate_org_prefix"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  base_prefix text; candidate text; words text[]; counter int := 0;
BEGIN
  IF NEW.org_prefix IS NOT NULL THEN RETURN NEW; END IF;
  words := regexp_split_to_array(UPPER(TRIM(COALESCE(NEW.display_name, NEW.legal_name, 'ORG'))), '\s+');
  IF array_length(words, 1) >= 3 THEN base_prefix := LEFT(words[1], 1) || LEFT(words[2], 1) || LEFT(words[3], 1);
  ELSIF array_length(words, 1) = 2 THEN base_prefix := LEFT(words[1], 2) || LEFT(words[2], 1);
  ELSE base_prefix := LEFT(words[1], 3); END IF;
  base_prefix := regexp_replace(base_prefix, '[^A-Z0-9]', '', 'g');
  IF LENGTH(base_prefix) < 2 THEN base_prefix := base_prefix || 'X'; END IF;
  candidate := base_prefix;
  WHILE EXISTS (SELECT 1 FROM organizations WHERE org_prefix = candidate AND id != NEW.id) LOOP
    counter := counter + 1; candidate := base_prefix || counter::text;
  END LOOP;
  NEW.org_prefix := candidate;
  RETURN NEW;
END; $$;


ALTER FUNCTION "public"."auto_generate_org_prefix"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_generate_org_public_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.public_id IS NULL THEN
    NEW.public_id := generate_public_id();

    WHILE EXISTS (SELECT 1 FROM organizations WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_public_id();
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."auto_generate_org_public_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_generate_profile_public_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.public_id IS NULL THEN
    NEW.public_id := generate_public_id();

    WHILE EXISTS (SELECT 1 FROM profiles WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_public_id();
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."auto_generate_profile_public_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_generate_public_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  src text;
  ct text;
  category text := 'DOC';
BEGIN
  -- Only generate if not already set
  IF NEW.public_id IS NULL THEN

    -- Determine category from pipeline_source in metadata first,
    -- then fall back to credential_type
    src := COALESCE(NEW.metadata->>'pipeline_source', '');
    ct  := COALESCE(NEW.credential_type::text, '');

    IF src = 'edgar' OR ct = 'SEC_FILING' THEN
      category := 'SEC';
    ELSIF src = 'uspto' OR ct = 'PATENT' THEN
      category := 'PAT';
    ELSIF src = 'federal_register' OR ct = 'REGULATION' THEN
      category := 'FED';
    ELSIF src IN ('openstates', 'sam_gov') THEN
      category := 'GOV';
    ELSIF src = 'courtlistener' OR ct = 'LEGAL' THEN
      category := 'LEG';
    ELSIF src = 'openalex' OR ct IN ('DEGREE', 'TRANSCRIPT', 'CERTIFICATE', 'CLE', 'BADGE', 'PUBLICATION') THEN
      category := 'ACD';
    ELSIF ct IN ('FINANCIAL', 'FINANCIAL_ADVISOR', 'INSURANCE', 'CHARITY', 'BUSINESS_ENTITY') THEN
      category := 'ORG';
    END IF;

    NEW.public_id := generate_anchor_public_id(category);

    -- Ensure uniqueness (retry on collision)
    WHILE EXISTS (SELECT 1 FROM anchors WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_anchor_public_id(category);
    END LOOP;

  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."auto_generate_public_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '120s'
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Insert all anchors, skip duplicates via partial unique index
  -- Then return both newly inserted AND pre-existing anchors
  WITH input_data AS (
    SELECT 
      (elem->>'user_id')::uuid AS user_id,
      (elem->>'org_id')::uuid AS org_id,
      (elem->>'fingerprint')::text AS fingerprint,
      (elem->>'filename')::text AS filename,
      (elem->>'credential_type')::credential_type AS credential_type,
      'PENDING'::anchor_status AS status,
      (elem->'metadata')::jsonb AS metadata
    FROM jsonb_array_elements(p_anchors) AS elem
  ),
  inserted AS (
    INSERT INTO anchors (user_id, org_id, fingerprint, filename, credential_type, status, metadata)
    SELECT user_id, org_id, fingerprint, filename, credential_type, status, metadata
    FROM input_data
    ON CONFLICT (user_id, fingerprint) WHERE deleted_at IS NULL 
    DO NOTHING
    RETURNING id, fingerprint
  ),
  -- Also look up any that already existed (were skipped by ON CONFLICT)
  existing AS (
    SELECT a.id, a.fingerprint
    FROM anchors a
    INNER JOIN input_data d ON a.user_id = d.user_id AND a.fingerprint = d.fingerprint
    WHERE a.deleted_at IS NULL
    AND a.id NOT IN (SELECT id FROM inserted)
  ),
  all_anchors AS (
    SELECT id, fingerprint FROM inserted
    UNION ALL
    SELECT id, fingerprint FROM existing
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'fingerprint', fingerprint))
  INTO v_result
  FROM all_anchors;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;


ALTER FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE
  caller_profile RECORD;
  anchor_record jsonb;
  created_count integer := 0;
  skipped_count integer := 0;
  failed_count integer := 0;
  results jsonb := '[]'::jsonb;
  new_anchor_id uuid;
  existing_anchor_id uuid;
  anchor_fingerprint text;
  anchor_filename text;
  anchor_file_size integer;
  anchor_credential_type credential_type;
  anchor_metadata jsonb;
  quota_remaining integer;
  batch_size integer;
  lock_key bigint;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001'; END IF;

  lock_key := ('x' || left(md5(auth.uid()::text), 15))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(lock_key);

  quota_remaining := check_anchor_quota();
  batch_size := jsonb_array_length(anchors_data);

  IF quota_remaining IS NOT NULL AND batch_size > quota_remaining THEN
    RAISE EXCEPTION 'Quota exceeded: % records remaining but % requested', quota_remaining, batch_size USING ERRCODE = 'P0002';
  END IF;

  FOR anchor_record IN SELECT * FROM jsonb_array_elements(anchors_data)
  LOOP
    anchor_fingerprint := lower(anchor_record->>'fingerprint');
    anchor_filename := anchor_record->>'filename';
    anchor_file_size := (anchor_record->>'fileSize')::integer;

    BEGIN
      IF anchor_record->>'credentialType' IS NOT NULL AND anchor_record->>'credentialType' != '' THEN
        anchor_credential_type := (anchor_record->>'credentialType')::credential_type;
      ELSE
        anchor_credential_type := NULL;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      anchor_credential_type := NULL;
    END;

    IF anchor_record->'metadata' IS NOT NULL AND jsonb_typeof(anchor_record->'metadata') = 'object' THEN
      anchor_metadata := anchor_record->'metadata';
    ELSE
      anchor_metadata := NULL;
    END IF;

    SELECT id INTO existing_anchor_id FROM anchors WHERE fingerprint = anchor_fingerprint AND user_id = auth.uid() AND deleted_at IS NULL;

    IF existing_anchor_id IS NOT NULL THEN
      skipped_count := skipped_count + 1;
      results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'skipped', 'reason', 'duplicate', 'existingId', existing_anchor_id);
    ELSE
      IF quota_remaining IS NOT NULL AND created_count >= quota_remaining THEN
        failed_count := failed_count + 1;
        results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'failed', 'reason', 'quota_exceeded');
        CONTINUE;
      END IF;

      BEGIN
        INSERT INTO anchors (user_id, org_id, fingerprint, filename, file_size, credential_type, metadata, status)
        VALUES (auth.uid(), caller_profile.org_id, anchor_fingerprint, anchor_filename, anchor_file_size, anchor_credential_type, anchor_metadata, 'PENDING')
        RETURNING id INTO new_anchor_id;

        created_count := created_count + 1;
        results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'created', 'id', new_anchor_id);
      EXCEPTION WHEN OTHERS THEN
        failed_count := failed_count + 1;
        results := results || jsonb_build_object('fingerprint', anchor_fingerprint, 'status', 'failed', 'reason', 'insert_failed');
      END;
    END IF;
  END LOOP;

  -- Audit event — actor_id only, NO actor_email (column dropped in 0170)
  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES ('BULK_VERIFICATION_RUN', 'ANCHOR', auth.uid(), caller_profile.org_id, 'batch',
    'bulk_create_' || to_char(now(), 'YYYYMMDD_HH24MISS'),
    jsonb_build_object('total', jsonb_array_length(anchors_data), 'created', created_count, 'skipped', skipped_count, 'failed', failed_count)::text);

  RETURN jsonb_build_object('total', jsonb_array_length(anchors_data), 'created', created_count, 'skipped', skipped_count, 'failed', failed_count, 'results', results);
END;
$$;


ALTER FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") IS 'Creates multiple anchors in a batch. Idempotent - skips duplicates based on fingerprint.';



CREATE OR REPLACE FUNCTION "public"."bulk_promote_confirmed"("p_tx_ids" "text"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE anchors 
  SET status = 'SECURED', updated_at = NOW()
  WHERE status = 'SUBMITTED' 
    AND deleted_at IS NULL
    AND chain_tx_id = ANY(p_tx_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."bulk_promote_confirmed"("p_tx_ids" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_export_user_data"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM data_subject_requests
    WHERE user_id = p_user_id
      AND request_type = 'export'
      AND status = 'completed'
      AND completed_at > now() - interval '24 hours'
  );
$$;


ALTER FUNCTION "public"."can_export_user_data"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_ai_credits"("p_org_id" "uuid" DEFAULT NULL::"uuid", "p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("monthly_allocation" integer, "used_this_month" integer, "remaining" integer, "has_credits" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ac.monthly_allocation,
    ac.used_this_month,
    (ac.monthly_allocation - ac.used_this_month) AS remaining,
    (ac.used_this_month < ac.monthly_allocation) AS has_credits
  FROM ai_credits ac
  WHERE
    (p_org_id IS NOT NULL AND ac.org_id = p_org_id)
    OR (p_user_id IS NOT NULL AND ac.user_id = p_user_id)
  AND ac.period_start <= now()
  AND ac.period_end > now()
  LIMIT 1;
END;
$$;


ALTER FUNCTION "public"."check_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_anchor_quota"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."check_anchor_quota"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."check_anchor_quota"() IS 'SCRUM-1261 (R1-7) lock: re-affirms 0084 beta no-quota policy that 0093 silently overrode. Memory: feedback_no_credit_limits_beta.md. CI: scripts/ci/feedback-rules/no-credit-limits-beta.ts (R0-7).';



CREATE OR REPLACE FUNCTION "public"."check_orphaned_anchors"() RETURNS TABLE("anchor_id" "uuid", "user_id" "uuid", "fingerprint" "text", "status" "text", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
    SELECT a.id AS anchor_id, a.user_id, a.fingerprint, a.status::text, a.created_at
    FROM anchors a
    LEFT JOIN profiles p ON p.id = a.user_id
    WHERE p.id IS NULL
      AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT 100;
END;
$$;


ALTER FUNCTION "public"."check_orphaned_anchors"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_role_immutability"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF OLD.role IS NOT NULL AND (
    NEW.role IS NULL OR
    NEW.role != OLD.role
  ) THEN
    RAISE EXCEPTION 'Role cannot be changed once set. Current role: %', OLD.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.role IS NULL AND NEW.role IS NOT NULL THEN
    NEW.role_set_at = now();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_role_immutability"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_sub_org_depth"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.parent_org_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM organizations WHERE id = NEW.parent_org_id AND parent_org_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Sub-organizations cannot create their own sub-organizations (one level deep only)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_sub_org_depth"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_unified_credits"("p_org_id" "uuid" DEFAULT NULL::"uuid", "p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("monthly_allocation" integer, "used_this_month" integer, "remaining" integer, "has_credits" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_record unified_credits%ROWTYPE;
BEGIN
  SELECT * INTO v_record FROM unified_credits uc
  WHERE (p_org_id IS NOT NULL AND uc.org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND uc.user_id = p_user_id)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 50, 0, 50, true;
    RETURN;
  END IF;

  IF v_record.billing_cycle_start < date_trunc('month', now()) THEN
    UPDATE unified_credits
    SET used_this_month = 0,
        carry_over = LEAST(v_record.monthly_allocation - v_record.used_this_month, 50),
        billing_cycle_start = date_trunc('month', now()),
        updated_at = now()
    WHERE id = v_record.id;
    v_record.used_this_month := 0;
    v_record.carry_over := LEAST(v_record.monthly_allocation - v_record.used_this_month, 50);
  END IF;

  RETURN QUERY SELECT
    v_record.monthly_allocation,
    v_record.used_this_month,
    (v_record.monthly_allocation + v_record.carry_over - v_record.used_this_month)::integer,
    (v_record.used_this_month < v_record.monthly_allocation + v_record.carry_over);
END;
$$;


ALTER FUNCTION "public"."check_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."job_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "priority" integer DEFAULT 0 NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 3 NOT NULL,
    "last_error" "text",
    "scheduled_for" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "job_queue_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text", 'dead'::"text"])))
);

ALTER TABLE ONLY "public"."job_queue" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_queue" OWNER TO "postgres";


COMMENT ON TABLE "public"."job_queue" IS 'PERF-13: Async job queue for worker processing. Service-role only.';



CREATE OR REPLACE FUNCTION "public"."claim_next_job"("p_type" "text", "p_now" timestamp with time zone) RETURNS SETOF "public"."job_queue"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE job_queue
  SET status = 'processing', attempts = attempts + 1, updated_at = p_now
  WHERE id = (
    SELECT id FROM job_queue
    WHERE type = p_type
      AND status IN ('pending', 'failed')
      AND (scheduled_for IS NULL OR scheduled_for <= p_now)
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;


ALTER FUNCTION "public"."claim_next_job"("p_type" "text", "p_now" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_pending_anchors"("p_worker_id" "text" DEFAULT 'worker-1'::"text", "p_limit" integer DEFAULT 50, "p_exclude_pipeline" boolean DEFAULT true, "p_org_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "user_id" "uuid", "org_id" "uuid", "fingerprint" "text", "public_id" "text", "metadata" "jsonb", "credential_type" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE anchors a
    SET
      status = 'BROADCASTING',
      updated_at = now(),
      metadata = jsonb_set(
        COALESCE(a.metadata, '{}'::jsonb),
        '{_claimed_by}',
        to_jsonb(p_worker_id)
      ) || jsonb_build_object('_claimed_at', to_jsonb(now()::text))
    WHERE a.id IN (
      SELECT a2.id
      FROM anchors a2
      WHERE a2.status = 'PENDING'
        AND a2.deleted_at IS NULL
        AND (p_org_id IS NULL OR a2.org_id = p_org_id)
        AND (
          NOT p_exclude_pipeline
          OR (a2.metadata->>'pipeline_source') IS NULL
        )
      ORDER BY a2.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 0), 10000)
    )
    RETURNING a.*
  )
  SELECT
    claimed.id, claimed.user_id, claimed.org_id,
    claimed.fingerprint::text, claimed.public_id,
    claimed.metadata, claimed.credential_type::text
  FROM claimed;
END;
$$;


ALTER FUNCTION "public"."claim_pending_anchors"("p_worker_id" "text", "p_limit" integer, "p_exclude_pipeline" boolean, "p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_pending_rule_events"("p_limit" integer DEFAULT 200) RETURNS TABLE("id" "uuid", "org_id" "uuid", "trigger_type" "public"."org_rule_trigger_type", "vendor" "text", "external_file_id" "text", "filename" "text", "folder_path" "text", "sender_email" "text", "subject" "text", "payload" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  UPDATE organization_rule_events e
  SET status = 'PENDING'::org_rule_event_status,
      claim_id = NULL,
      claimed_at = NULL,
      error = COALESCE(e.error, 'Recovered stale CLAIMED event')
  WHERE e.status = 'CLAIMED'
    AND e.claimed_at < now() - INTERVAL '15 minutes'
    AND e.attempt_count < 5;

  UPDATE organization_rule_events e
  SET status = 'FAILED'::org_rule_event_status,
      claim_id = NULL,
      error = COALESCE(e.error, 'Rule event exceeded max claim attempts')
  WHERE e.status = 'CLAIMED'
    AND e.claimed_at < now() - INTERVAL '15 minutes'
    AND e.attempt_count >= 5;

  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM organization_rule_events q
    WHERE q.status = 'PENDING'
    ORDER BY q.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  ),
  claimed AS (
    UPDATE organization_rule_events q
    SET status = 'CLAIMED'::org_rule_event_status,
        claim_id = gen_random_uuid(),
        claimed_at = now(),
        attempt_count = q.attempt_count + 1,
        error = NULL
    FROM picked
    WHERE q.id = picked.id
    RETURNING
      q.id, q.org_id, q.trigger_type, q.vendor, q.external_file_id,
      q.filename, q.folder_path, q.sender_email, q.subject, q.payload
  )
  SELECT
    claimed.id, claimed.org_id, claimed.trigger_type, claimed.vendor,
    claimed.external_file_id, claimed.filename, claimed.folder_path,
    claimed.sender_email, claimed.subject, claimed.payload
  FROM claimed
  ORDER BY claimed.id ASC;
END;
$$;


ALTER FUNCTION "public"."claim_pending_rule_events"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_expired_data"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_webhook_count integer := 0;
  v_verification_count integer := 0;
  v_ai_usage_count integer := 0;
  v_audit_count integer := 0;
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can run data cleanup' USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM webhook_delivery_logs WHERE created_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS v_webhook_count = ROW_COUNT;

  DELETE FROM verification_events WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_verification_count = ROW_COUNT;

  DELETE FROM ai_usage_events WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_ai_usage_count = ROW_COUNT;

  DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;

  DELETE FROM audit_events
  WHERE created_at < now() - INTERVAL '2 years'
    AND NOT EXISTS (
      SELECT 1 FROM anchors WHERE anchors.id::text = audit_events.target_id AND anchors.legal_hold = true
    );
  GET DIAGNOSTICS v_audit_count = ROW_COUNT;

  CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_modification();

  INSERT INTO audit_events (event_type, event_category, actor_id, details)
  VALUES ('DATA_RETENTION_CLEANUP', 'SYSTEM', NULL,
    jsonb_build_object(
      'webhook_delivery_logs_deleted', v_webhook_count,
      'verification_events_deleted', v_verification_count,
      'ai_usage_events_deleted', v_ai_usage_count,
      'audit_events_deleted', v_audit_count,
      'retention_policy', jsonb_build_object('webhook_delivery_logs', '90 days', 'verification_events', '1 year', 'ai_usage_events', '1 year', 'audit_events', '2 years')
    )::text);

  RETURN jsonb_build_object(
    'success', true,
    'webhook_delivery_logs_deleted', v_webhook_count,
    'verification_events_deleted', v_verification_count,
    'ai_usage_events_deleted', v_ai_usage_count,
    'audit_events_deleted', v_audit_count
  );
END;
$$;


ALTER FUNCTION "public"."cleanup_expired_data"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_orphaned_anchors"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  cleaned integer;
BEGIN
  WITH orphans AS (
    UPDATE anchors a
    SET deleted_at = now()
    WHERE a.user_id NOT IN (SELECT id FROM profiles)
      AND a.deleted_at IS NULL
    RETURNING a.id
  )
  SELECT count(*) INTO cleaned FROM orphans;

  IF cleaned > 0 THEN
    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, details)
    VALUES (
      'ORPHAN_CLEANUP', 'SYSTEM',
      '00000000-0000-0000-0000-000000000000'::uuid,
      'anchor',
      format('Soft-deleted %s orphaned anchors', cleaned)
    );
  END IF;
  RETURN cleaned;
END;
$$;


ALTER FUNCTION "public"."cleanup_orphaned_anchors"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_payment_grace"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE organizations
  SET
    payment_state = NULL,
    payment_grace_expires_at = NULL,
    payment_state_updated_at = now()
  WHERE id = p_org_id;
  RETURN jsonb_build_object('ok', true, 'org_id', p_org_id);
END;
$$;


ALTER FUNCTION "public"."clear_payment_grace"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_claimed_rule_events"("p_event_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE organization_rule_events q
  SET status = 'PROCESSED'::org_rule_event_status,
      processed_at = now(),
      claim_id = NULL,
      error = NULL
  WHERE q.id = ANY(COALESCE(p_event_ids, ARRAY[]::UUID[]))
    AND q.status = 'CLAIMED';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."complete_claimed_rule_events"("p_event_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."count_public_records_by_source"() RETURNS TABLE("source" "text", "count" bigint)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF;

  RETURN QUERY
  SELECT kv.key::text AS source, (kv.value)::text::bigint AS count
  FROM pipeline_dashboard_cache pdc, LATERAL jsonb_each(pdc.cache_value) AS kv
  WHERE pdc.cache_key = 'by_source'
  ORDER BY (kv.value)::text::bigint DESC;
END;
$$;


ALTER FUNCTION "public"."count_public_records_by_source"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_pending_recipient"("p_email" "text", "p_org_id" "uuid", "p_full_name" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  caller_profile RECORD;
  existing_profile RECORD;
  new_id UUID;
  token TEXT;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001'; END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can create pending recipients' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF caller_profile.org_id IS NULL OR caller_profile.org_id != p_org_id THEN
    RAISE EXCEPTION 'Cannot create recipients for a different organization' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO existing_profile FROM profiles WHERE email = lower(trim(p_email));
  IF FOUND THEN RETURN existing_profile.id; END IF;

  token := encode(gen_random_bytes(32), 'hex');
  new_id := gen_random_uuid();

  INSERT INTO profiles (id, email, full_name, org_id, role, status, activation_token, activation_token_expires_at, created_at, updated_at)
  VALUES (new_id, lower(trim(p_email)), p_full_name, p_org_id, 'MEMBER', 'PENDING_ACTIVATION', token, now() + interval '7 days', now(), now());

  -- Audit event — actor_id only, NO actor_email (column dropped in 0170)
  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES ('USER_INVITED', 'USER', auth.uid(), p_org_id, 'profile', new_id::text,
    jsonb_build_object('recipient_email', lower(trim(p_email)))::text);

  RETURN new_id;
END;
$$;


ALTER FUNCTION "public"."create_pending_recipient"("p_email" "text", "p_org_id" "uuid", "p_full_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_profile_for_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, created_at, updated_at)
  VALUES (
    NEW.id,
    LOWER(COALESCE(NEW.email, '')),
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."create_profile_for_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_webhook_endpoint"("p_url" "text", "p_events" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_org_id uuid;
  v_is_admin boolean;
  v_endpoint_id uuid;
  v_secret text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT p.org_id, (p.role = 'ORG_ADMIN') INTO v_org_id, v_is_admin FROM profiles p WHERE p.id = v_user_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'User has no organization'; END IF;
  IF NOT v_is_admin THEN RAISE EXCEPTION 'Only ORG_ADMIN can create webhook endpoints'; END IF;
  IF p_url IS NULL OR p_url !~ '^https://' THEN RAISE EXCEPTION 'URL must start with https://'; END IF;
  IF p_events IS NULL OR array_length(p_events, 1) IS NULL THEN RAISE EXCEPTION 'At least one event must be selected'; END IF;

  v_secret := 'whsec_' || encode(gen_random_bytes(32), 'hex');

  INSERT INTO webhook_endpoints (org_id, url, events, secret_hash, is_active) VALUES (v_org_id, p_url, p_events, v_secret, true) RETURNING id INTO v_endpoint_id;

  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES ('WEBHOOK_ENDPOINT_CREATED', 'WEBHOOK', v_user_id, v_org_id, 'webhook_endpoint', v_endpoint_id::text, jsonb_build_object('url', p_url, 'events', to_jsonb(p_events))::text);

  RETURN jsonb_build_object('id', v_endpoint_id, 'secret', v_secret);
END;
$$;


ALTER FUNCTION "public"."create_webhook_endpoint"("p_url" "text", "p_events" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deduct_ai_credits"("p_org_id" "uuid" DEFAULT NULL::"uuid", "p_user_id" "uuid" DEFAULT NULL::"uuid", "p_amount" integer DEFAULT 1) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT (monthly_allocation - used_this_month) INTO v_remaining
  FROM ai_credits
  WHERE
    ((p_org_id IS NOT NULL AND org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND user_id = p_user_id))
    AND period_start <= now()
    AND period_end > now()
  FOR UPDATE;

  IF v_remaining IS NULL OR v_remaining < p_amount THEN
    RETURN false;
  END IF;

  UPDATE ai_credits
  SET used_this_month = used_this_month + p_amount,
      updated_at = now()
  WHERE
    ((p_org_id IS NOT NULL AND org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND user_id = p_user_id))
    AND period_start <= now()
    AND period_end > now();

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."deduct_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deduct_credit"("p_user_id" "uuid", "p_amount" integer DEFAULT 1, "p_reason" "text" DEFAULT 'Anchor creation'::"text", "p_reference_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_current_balance integer;
  v_new_balance integer;
BEGIN
  SELECT balance INTO v_current_balance
  FROM credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_current_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'No credit record found', 'success', false);
  END IF;

  IF v_current_balance < p_amount THEN
    RETURN jsonb_build_object(
      'error', 'Insufficient credits',
      'success', false,
      'balance', v_current_balance,
      'required', p_amount
    );
  END IF;

  v_new_balance := v_current_balance - p_amount;

  UPDATE credits
  SET balance = v_new_balance, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason, reference_id)
  VALUES (p_user_id, 'DEDUCTION', -p_amount, v_new_balance, p_reason, p_reference_id);

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_new_balance,
    'deducted', p_amount
  );
END;
$$;


ALTER FUNCTION "public"."deduct_credit"("p_user_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deduct_org_credit"("p_org_id" "uuid", "p_amount" integer, "p_reason" "text" DEFAULT 'anchor.create'::"text", "p_reference_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_balance integer;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;

  SELECT balance INTO v_balance FROM org_credits WHERE org_id = p_org_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'org_not_initialized', 'success', false);
  END IF;
  IF v_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_credits',
      'balance', v_balance,
      'required', p_amount
    );
  END IF;

  UPDATE org_credits SET balance = balance - p_amount, updated_at = now() WHERE org_id = p_org_id;

  RETURN jsonb_build_object(
    'success', true,
    'balance', v_balance - p_amount,
    'deducted', p_amount,
    'reason', p_reason,
    'reference_id', p_reference_id
  );
END;
$$;


ALTER FUNCTION "public"."deduct_org_credit"("p_org_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deduct_unified_credits"("p_org_id" "uuid" DEFAULT NULL::"uuid", "p_user_id" "uuid" DEFAULT NULL::"uuid", "p_amount" integer DEFAULT 1) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_record unified_credits%ROWTYPE;
  v_available integer;
BEGIN
  SELECT * INTO v_record FROM unified_credits uc
  WHERE (p_org_id IS NOT NULL AND uc.org_id = p_org_id)
     OR (p_user_id IS NOT NULL AND uc.user_id = p_user_id)
  FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;

  v_available := v_record.monthly_allocation + v_record.carry_over - v_record.used_this_month;
  IF v_available < p_amount THEN RETURN false; END IF;

  UPDATE unified_credits SET used_this_month = used_this_month + p_amount, updated_at = now()
  WHERE id = v_record.id;
  RETURN true;
END;
$$;


ALTER FUNCTION "public"."deduct_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_own_account"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_anonymize_result jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_user_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Account already deleted' USING ERRCODE = 'check_violation';
  END IF;
  SELECT anonymize_user_data(v_user_id) INTO v_anonymize_result;
  UPDATE profiles SET deleted_at = now() WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, details)
  VALUES ('ACCOUNT_DELETED', 'SYSTEM', v_user_id, 'profile', v_user_id::text, jsonb_build_object('gdpr_article', '17', 'initiated_by', 'user')::text);
  RETURN jsonb_build_object('success', true, 'message', 'Account deleted. Personal data has been anonymized.');
END;
$$;


ALTER FUNCTION "public"."delete_own_account"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_webhook_endpoint"("p_endpoint_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_org_id uuid;
  v_is_admin boolean;
  v_endpoint_org_id uuid;
  v_endpoint_url text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT p.org_id, (p.role = 'ORG_ADMIN') INTO v_org_id, v_is_admin FROM profiles p WHERE p.id = v_user_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'User has no organization'; END IF;
  IF NOT v_is_admin THEN RAISE EXCEPTION 'Only ORG_ADMIN can delete webhook endpoints'; END IF;

  SELECT org_id, url INTO v_endpoint_org_id, v_endpoint_url FROM webhook_endpoints WHERE id = p_endpoint_id;
  IF v_endpoint_org_id IS NULL THEN RAISE EXCEPTION 'Endpoint not found'; END IF;
  IF v_endpoint_org_id != v_org_id THEN RAISE EXCEPTION 'Cannot delete endpoint from another organization'; END IF;

  DELETE FROM webhook_endpoints WHERE id = p_endpoint_id;

  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES ('WEBHOOK_ENDPOINT_DELETED', 'WEBHOOK', v_user_id, v_org_id, 'webhook_endpoint', p_endpoint_id::text, jsonb_build_object('url', v_endpoint_url)::text);
END;
$$;


ALTER FUNCTION "public"."delete_webhook_endpoint"("p_endpoint_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer DEFAULT 1000) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_updated int;
  v_total_updated int := 0;
  v_iterations int := 0;
  v_max_iterations int := 20;
BEGIN
  -- Tell triggers we're service_role so they short-circuit. SECURITY
  -- DEFINER doesn't change get_caller_role's reading of the JWT claim.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  LOOP
    WITH batch AS (
      SELECT id FROM anchors
      WHERE chain_tx_id = p_chain_tx_id
        AND status = 'SUBMITTED'
        AND deleted_at IS NULL
      LIMIT p_batch_size
    )
    UPDATE anchors a
    SET status = 'SECURED',
        chain_block_height = p_block_height,
        chain_timestamp = p_block_timestamp
    FROM batch
    WHERE a.id = batch.id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_total_updated := v_total_updated + v_updated;
    v_iterations := v_iterations + 1;

    EXIT WHEN v_updated < p_batch_size OR v_iterations >= v_max_iterations;
  END LOOP;

  RETURN jsonb_build_object(
    'tx_id', p_chain_tx_id,
    'updated', v_total_updated,
    'iterations', v_iterations,
    'capped', v_iterations >= v_max_iterations
  );
END;
$$;


ALTER FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer DEFAULT 100, "p_max_iterations" integer DEFAULT 5, "p_confirmations" integer DEFAULT 1) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '50s'
    AS $$
DECLARE
  v_updated int;
  v_updated_anchors jsonb;
  v_anchors jsonb := '[]'::jsonb;
  v_total_updated int := 0;
  v_iterations int := 0;
BEGIN
  -- Tell BEFORE-UPDATE triggers to short-circuit. SECURITY DEFINER doesn't
  -- change get_caller_role()'s reading of the JWT claim GUC.
  -- Contract: protect_anchor_fields/protect_anchor_status_transition and the
  -- duplicate-metadata guard depend on get_caller_role() honoring this
  -- service_role GUC. Preserve that trigger short-circuit if those guards are
  -- refactored.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  LOOP
    WITH batch AS (
      SELECT id FROM anchors
      WHERE chain_tx_id = p_chain_tx_id
        AND status = 'SUBMITTED'
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE anchors a
      SET status = 'SECURED',
          chain_block_height = p_block_height,
          chain_timestamp = p_block_timestamp,
          chain_confirmations = GREATEST(p_confirmations, 1)
      FROM batch
      WHERE a.id = batch.id
      RETURNING a.id, a.public_id, a.org_id, a.fingerprint
    ),
    chain_index AS (
      INSERT INTO public.anchor_chain_index (
        fingerprint_sha256,
        chain_tx_id,
        chain_block_height,
        chain_block_timestamp,
        confirmations,
        anchor_id
      )
      SELECT
        u.fingerprint,
        p_chain_tx_id,
        p_block_height,
        p_block_timestamp,
        GREATEST(p_confirmations, 1),
        u.id
      FROM updated u
      WHERE u.fingerprint IS NOT NULL
      ON CONFLICT (fingerprint_sha256, chain_tx_id) DO UPDATE
      SET chain_block_height = EXCLUDED.chain_block_height,
          chain_block_timestamp = EXCLUDED.chain_block_timestamp,
          confirmations = GREATEST(COALESCE(public.anchor_chain_index.confirmations, 0), EXCLUDED.confirmations),
          anchor_id = EXCLUDED.anchor_id
      RETURNING 1
    )
    SELECT
      count(*)::int,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'public_id', public_id,
            'org_id', org_id
          )
        ),
        '[]'::jsonb
      )
    INTO v_updated, v_updated_anchors
    FROM updated;

    v_total_updated := v_total_updated + v_updated;
    v_anchors := v_anchors || v_updated_anchors;
    v_iterations := v_iterations + 1;

    EXIT WHEN v_updated < p_batch_size OR v_iterations >= p_max_iterations;
  END LOOP;

  RETURN jsonb_build_object(
    'tx_id', p_chain_tx_id,
    'updated', v_total_updated,
    'iterations', v_iterations,
    'anchors', v_anchors,
    'capped', v_iterations >= p_max_iterations
  );
END;
$$;


ALTER FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_lowercase_email"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.email = lower(NEW.email);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_lowercase_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_org_parent_depth"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  depth integer := 1;
  cursor_id uuid := NEW.parent_org_id;
  visited uuid[] := ARRAY[]::uuid[];
  step_limit integer := 10;
BEGIN
  IF NEW.parent_org_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_org_id = NEW.id THEN
    RAISE EXCEPTION 'org_self_parent_forbidden' USING ERRCODE = 'check_violation';
  END IF;
  WHILE cursor_id IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 3 THEN
      RAISE EXCEPTION 'org_depth_exceeded_3'
        USING ERRCODE = 'check_violation',
              DETAIL = 'organizations.parent_org_id chain depth must be <= 3';
    END IF;
    IF cursor_id = ANY (visited) THEN
      RAISE EXCEPTION 'org_parent_cycle_detected'
        USING ERRCODE = 'check_violation';
    END IF;
    visited := array_append(visited, cursor_id);
    step_limit := step_limit - 1;
    EXIT WHEN step_limit <= 0;
    SELECT parent_org_id INTO cursor_id
    FROM organizations WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_org_parent_depth"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_audit_for_cloud_logging"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- ON CONFLICT DO NOTHING — if the trigger somehow fires twice, we stay
  -- at-most-once. The Cloud Logging insertId dedup is the backstop.
  INSERT INTO cloud_logging_queue (audit_id)
  VALUES (NEW.id)
  ON CONFLICT (audit_id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enqueue_audit_for_cloud_logging"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_rule_event"("p_org_id" "uuid", "p_trigger_type" "public"."org_rule_trigger_type", "p_vendor" "text" DEFAULT NULL::"text", "p_external_file_id" "text" DEFAULT NULL::"text", "p_filename" "text" DEFAULT NULL::"text", "p_folder_path" "text" DEFAULT NULL::"text", "p_sender_email" "text" DEFAULT NULL::"text", "p_subject" "text" DEFAULT NULL::"text", "p_payload" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO organization_rule_events (
    org_id, trigger_type, vendor, external_file_id, filename, folder_path,
    sender_email, subject, payload
  ) VALUES (
    p_org_id, p_trigger_type, NULLIF(trim(p_vendor), ''),
    NULLIF(trim(p_external_file_id), ''), NULLIF(trim(p_filename), ''),
    NULLIF(trim(p_folder_path), ''),
    CASE
      WHEN p_sender_email IS NULL THEN NULL
      ELSE NULLIF(lower(trim(p_sender_email)), '')
    END,
    NULLIF(trim(p_subject), ''),
    COALESCE(p_payload, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."enqueue_rule_event"("p_org_id" "uuid", "p_trigger_type" "public"."org_rule_trigger_type", "p_vendor" "text", "p_external_file_id" "text", "p_filename" "text", "p_folder_path" "text", "p_sender_email" "text", "p_subject" "text", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_payment_grace_if_due"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count integer;
BEGIN
  WITH expired AS (
    UPDATE organizations
    SET
      payment_state = 'suspended',
      payment_state_updated_at = now()
    WHERE payment_state = 'grace'
      AND payment_grace_expires_at IS NOT NULL
      AND payment_grace_expires_at <= now()
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM expired;
  RETURN COALESCE(v_count, 0);
END;
$$;


ALTER FUNCTION "public"."expire_payment_grace_if_due"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_public_record_anchor_batch"("p_items" "jsonb", "p_tx_id" "text", "p_block_height" bigint DEFAULT NULL::bigint, "p_block_timestamp" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_merkle_root" "text" DEFAULT NULL::"text", "p_batch_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '120s'
    AS $$
DECLARE
  v_anchors_updated bigint := 0;
  v_records_updated bigint := 0;
BEGIN
  WITH input_data AS (
    SELECT
      (elem->>'record_id')::uuid AS record_id,
      (elem->>'anchor_id')::uuid AS anchor_id,
      COALESCE(elem->'merkle_proof', '[]'::jsonb) AS merkle_proof
    FROM jsonb_array_elements(p_items) AS elem
  ),
  anchor_input AS (
    SELECT DISTINCT ON (anchor_id) anchor_id, merkle_proof
    FROM input_data
    ORDER BY anchor_id
  ),
  updated_anchors AS (
    UPDATE anchors a
    SET
      status = 'SUBMITTED',
      chain_tx_id = p_tx_id,
      chain_block_height = p_block_height,
      chain_timestamp = p_block_timestamp,
      updated_at = now(),
      metadata = COALESCE(a.metadata, '{}'::jsonb)
        - '_claimed_by' - '_claimed_at'
        || jsonb_build_object(
          'merkle_proof', ai.merkle_proof,
          'merkle_root', p_merkle_root,
          'batch_id', p_batch_id
        )
    FROM anchor_input ai
    WHERE a.id = ai.anchor_id
      AND a.deleted_at IS NULL
      AND a.status = 'BROADCASTING'
    RETURNING a.id
  ),
  eligible_items AS (
    SELECT i.*
    FROM input_data i
    JOIN anchors a ON a.id = i.anchor_id
    WHERE a.deleted_at IS NULL
      AND a.status IN ('SUBMITTED', 'SECURED')
      AND a.chain_tx_id = p_tx_id
  ),
  updated_records AS (
    UPDATE public_records pr
    SET
      anchor_id = ei.anchor_id,
      updated_at = now(),
      metadata = COALESCE(pr.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'merkle_proof', ei.merkle_proof,
          'merkle_root', p_merkle_root,
          'batch_id', p_batch_id,
          'chain_tx_id', p_tx_id
        )
    FROM eligible_items ei
    WHERE pr.id = ei.record_id
      AND (pr.anchor_id IS NULL OR pr.anchor_id = ei.anchor_id)
    RETURNING pr.id
  )
  SELECT
    (SELECT count(*) FROM updated_anchors),
    (SELECT count(*) FROM updated_records)
  INTO v_anchors_updated, v_records_updated;

  RETURN jsonb_build_object(
    'anchors_updated', COALESCE(v_anchors_updated, 0),
    'records_updated', COALESCE(v_records_updated, 0)
  );
END;
$$;


ALTER FUNCTION "public"."finalize_public_record_anchor_batch"("p_items" "jsonb", "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."finalize_public_record_anchor_batch"("p_items" "jsonb", "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") IS 'Finalizes public-record Merkle batches without rewriting anchors.metadata; proof data lives in anchor_proofs.';



CREATE OR REPLACE FUNCTION "public"."generate_anchor_public_id"("category" "text" DEFAULT 'DOC'::"text") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  suffix text := '';
  i integer;
BEGIN
  FOR i IN 1..6 LOOP
    suffix := suffix || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN 'ARK-' || upper(category) || '-' || suffix;
END;
$$;


ALTER FUNCTION "public"."generate_anchor_public_id"("category" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_attestation_public_id"("p_org_prefix" "text", "p_attestation_type" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE type_code text; unique_part text; result text;
BEGIN
  type_code := CASE p_attestation_type
    WHEN 'VERIFICATION' THEN 'VER' WHEN 'ENDORSEMENT' THEN 'END' WHEN 'AUDIT' THEN 'AUD'
    WHEN 'APPROVAL' THEN 'APR' WHEN 'WITNESS' THEN 'WIT' WHEN 'COMPLIANCE' THEN 'COM'
    WHEN 'SUPPLY_CHAIN' THEN 'SUP' WHEN 'IDENTITY' THEN 'IDN' WHEN 'CUSTOM' THEN 'CUS'
    ELSE 'ATT' END;
  unique_part := UPPER(LEFT(gen_random_uuid()::text, 6));
  result := 'ARK-' || COALESCE(p_org_prefix, 'IND') || '-' || type_code || '-' || unique_part;
  WHILE EXISTS (SELECT 1 FROM attestations WHERE public_id = result) LOOP
    unique_part := UPPER(LEFT(gen_random_uuid()::text, 6));
    result := 'ARK-' || COALESCE(p_org_prefix, 'IND') || '-' || type_code || '-' || unique_part;
  END LOOP;
  RETURN result;
END; $$;


ALTER FUNCTION "public"."generate_attestation_public_id"("p_org_prefix" "text", "p_attestation_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_public_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  chars text := 'abcdefghjkmnpqrstuvwxyz23456789';
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..12 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$;


ALTER FUNCTION "public"."generate_public_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."generate_public_id"() IS 'Generates non-guessable public ID';



CREATE OR REPLACE FUNCTION "public"."get_agents_for_user"("p_user_id" "uuid") RETURNS TABLE("id" "uuid", "name" "text", "agent_type" "text", "status" "text", "allowed_scopes" "text"[], "framework" "text", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT a.id, a.name, a.agent_type::text, a.status::text, a.allowed_scopes, a.framework, a.created_at
  FROM agents a
  JOIN org_members om ON om.org_id = a.org_id
  WHERE om.user_id = p_user_id AND a.status = 'active'
  ORDER BY a.created_at DESC
  LIMIT 100;
$$;


ALTER FUNCTION "public"."get_agents_for_user"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_agents_for_user"("p_user_id" "uuid") IS 'MCP security: org-scoped agent list for the edge list_agents tool';



CREATE OR REPLACE FUNCTION "public"."get_anchor_backlog_stats"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '15s'
    AS $$
DECLARE
  v_pending_total        bigint;
  v_pending_pipeline     bigint;
  v_pending_non_pipeline bigint;
  v_broadcasting         bigint;
  v_submitted_unconfirmed bigint;
  v_secured              bigint;
  v_oldest_pending       timestamptz;
BEGIN
  -- PENDING total (uses idx_anchors_pending_claim).
  SELECT COUNT(*) INTO v_pending_total
  FROM anchors
  WHERE status = 'PENDING' AND deleted_at IS NULL;

  -- PENDING pipeline subset (same index, in-memory filter).
  SELECT COUNT(*) INTO v_pending_pipeline
  FROM anchors
  WHERE status = 'PENDING'
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NOT NULL;

  v_pending_non_pipeline := v_pending_total - v_pending_pipeline;

  -- BROADCASTING (uses idx_anchors_broadcasting_status from 0111).
  SELECT COUNT(*) INTO v_broadcasting
  FROM anchors
  WHERE status = 'BROADCASTING' AND deleted_at IS NULL;

  -- SUBMITTED without a confirmed block yet (still in Bitcoin mempool).
  SELECT COUNT(*) INTO v_submitted_unconfirmed
  FROM anchors
  WHERE status = 'SUBMITTED'
    AND deleted_at IS NULL
    AND chain_block_height IS NULL;

  -- SECURED total — rough proxy for "anchors the worker has fully processed".
  SELECT COUNT(*) INTO v_secured
  FROM anchors
  WHERE status = 'SECURED' AND deleted_at IS NULL;

  SELECT MIN(created_at) INTO v_oldest_pending
  FROM anchors
  WHERE status = 'PENDING' AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'pending_total',            v_pending_total,
    'pending_pipeline',         v_pending_pipeline,
    'pending_non_pipeline',     v_pending_non_pipeline,
    'broadcasting',             v_broadcasting,
    'submitted_unconfirmed',    v_submitted_unconfirmed,
    'secured',                  v_secured,
    'oldest_pending_created_at', v_oldest_pending,
    'oldest_pending_age_seconds',
      CASE
        WHEN v_oldest_pending IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (now() - v_oldest_pending))::bigint
      END,
    'collected_at', now()
  );
END;
$$;


ALTER FUNCTION "public"."get_anchor_backlog_stats"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_anchor_backlog_stats"() IS 'Snapshot of the anchor backlog (counts per status + oldest PENDING age). Bounded at 15s. Safe to call frequently from dashboards / worker diagnostics.';



CREATE OR REPLACE FUNCTION "public"."get_anchor_lineage"("p_public_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_anchor_id UUID;
  v_root_id   UUID;
  v_result    jsonb;
BEGIN
  SELECT id INTO v_anchor_id
  FROM anchors
  WHERE public_id = p_public_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  WITH RECURSIVE ancestry AS (
    SELECT id, parent_anchor_id, 1 AS hop
    FROM anchors
    WHERE id = v_anchor_id
    UNION ALL
    SELECT a.id, a.parent_anchor_id, ancestry.hop + 1
    FROM anchors a
    INNER JOIN ancestry ON a.id = ancestry.parent_anchor_id
    WHERE ancestry.hop < 100
      AND a.deleted_at IS NULL
  )
  SELECT id INTO v_root_id
  FROM ancestry
  WHERE parent_anchor_id IS NULL
  LIMIT 1;

  IF v_root_id IS NULL THEN
    v_root_id := v_anchor_id;
  END IF;

  WITH RECURSIVE descendants AS (
    SELECT a.*, 1 AS hop FROM anchors a
    WHERE a.id = v_root_id AND a.deleted_at IS NULL
    UNION ALL
    SELECT a.*, d.hop + 1 FROM anchors a
    INNER JOIN descendants d ON a.parent_anchor_id = d.id
    WHERE a.deleted_at IS NULL AND d.hop < 100
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'public_id', d.public_id,
      'credential_type', d.credential_type,
      'version_number', d.version_number,
      'parent_public_id', parent.public_id,
      'status', d.status::text,
      'fingerprint', d.fingerprint,
      'chain_tx_id', d.chain_tx_id,
      'chain_block_height', d.chain_block_height,
      'chain_timestamp', d.chain_timestamp,
      'created_at', d.created_at,
      'revoked_at', d.revoked_at,
      'is_current', (d.status NOT IN ('REVOKED', 'SUPERSEDED'))
    )
    ORDER BY d.version_number ASC
  ) INTO v_result
  FROM descendants d
  LEFT JOIN anchors parent ON parent.id = d.parent_anchor_id AND parent.deleted_at IS NULL
  WHERE d.status::text IN ('SECURED', 'CONFIRMED', 'REVOKED', 'EXPIRED', 'SUPERSEDED');

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;


ALTER FUNCTION "public"."get_anchor_lineage"("p_public_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_anchor_lineage"("p_public_id" "text") IS 'ARK-104/SCRUM-897: return public-safe lineage for the chain containing p_public_id, including credential_type for worker-mediated attestor credential APIs. Emits no internal UUIDs; direct anon RPC access is revoked.';



CREATE OR REPLACE FUNCTION "public"."get_anchor_status_counts"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_cached jsonb;
BEGIN
  SELECT cache_value INTO v_cached FROM pipeline_dashboard_cache WHERE cache_key = 'anchor_status_counts';
  IF v_cached IS NOT NULL THEN RETURN v_cached::json; END IF;
  RETURN json_build_object('PENDING', 0, 'SUBMITTED', 0, 'BROADCASTING', 0,
    'SECURED', 0, 'REVOKED', 0, 'total', 0, 'cache_miss', true);
END;
$$;


ALTER FUNCTION "public"."get_anchor_status_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_anchor_status_counts_fast"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '8s'
    AS $$
DECLARE
  v_total bigint := 0;
  v_pending bigint := 0;
  v_submitted bigint := 0;
  v_broadcasting bigint := 0;
  v_revoked bigint := 0;
  v_secured bigint := 0;
BEGIN
  IF NOT (
    get_caller_role() = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  -- Total: instant via pg_class.reltuples (ANALYZE last ran 2026-04-24).
  SELECT GREATEST(reltuples::bigint, 0) INTO v_total
  FROM pg_class
  WHERE relname = 'anchors' AND relnamespace = 'public'::regnamespace;

  -- Per-status counts: 1s budget each. -1 = unavailable (caller renders "—").
  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_pending FROM anchors
      WHERE status = 'PENDING' AND deleted_at IS NULL;
  EXCEPTION WHEN OTHERS THEN v_pending := -1; END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_submitted FROM anchors
      WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
  EXCEPTION WHEN OTHERS THEN v_submitted := -1; END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_broadcasting FROM anchors
      WHERE status = 'BROADCASTING' AND deleted_at IS NULL;
  EXCEPTION WHEN OTHERS THEN v_broadcasting := -1; END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_revoked FROM anchors
      WHERE status = 'REVOKED' AND deleted_at IS NULL;
  EXCEPTION WHEN OTHERS THEN v_revoked := -1; END;

  -- Derive SECURED. Only subtract buckets that succeeded (non-negative).
  v_secured := GREATEST(
    v_total
      - GREATEST(v_pending, 0)
      - GREATEST(v_submitted, 0)
      - GREATEST(v_broadcasting, 0)
      - GREATEST(v_revoked, 0),
    0
  );

  RETURN json_build_object(
    'PENDING', v_pending,
    'SUBMITTED', v_submitted,
    'BROADCASTING', v_broadcasting,
    'SECURED', v_secured,
    'REVOKED', v_revoked,
    'total', v_total
  );
END;
$$;


ALTER FUNCTION "public"."get_anchor_status_counts_fast"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_anchor_tx_stats"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_cached jsonb;
BEGIN
  SELECT cache_value INTO v_cached FROM pipeline_dashboard_cache WHERE cache_key = 'anchor_tx_stats';
  IF v_cached IS NOT NULL THEN RETURN v_cached::json; END IF;
  RETURN json_build_object('distinct_tx_count', 0, 'anchors_with_tx', 0, 'total_anchors', 0,
    'last_anchor_time', NULL, 'last_tx_time', NULL, 'cache_miss', true);
END;
$$;


ALTER FUNCTION "public"."get_anchor_tx_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_anchor_type_counts"() RETURNS TABLE("credential_type" "text", "status" "text", "count" bigint)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF;

  RETURN QUERY
  SELECT (row_obj->>'credential_type')::text, (row_obj->>'status')::text, (row_obj->>'count')::bigint
  FROM pipeline_dashboard_cache pdc, LATERAL jsonb_array_elements(pdc.cache_value) AS row_obj
  WHERE pdc.cache_key = 'anchor_type_counts';
END;
$$;


ALTER FUNCTION "public"."get_anchor_type_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_caller_role"() RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  role_val text;
  claims_json text;
BEGIN
  -- Try legacy GUC first (PostgREST < v12)
  role_val := current_setting('request.jwt.claim.role', true);
  IF role_val IS NOT NULL AND role_val != '' THEN
    RETURN role_val;
  END IF;
  
  -- Fall back to modern JSON claims (PostgREST v12+)
  claims_json := current_setting('request.jwt.claims', true);
  IF claims_json IS NOT NULL AND claims_json != '' THEN
    RETURN (claims_json::jsonb ->> 'role');
  END IF;
  
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."get_caller_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_anchor_public_id"("p_public_id" "text") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_anchor_id UUID;
  v_current_id UUID;
  v_current_public_id TEXT;
BEGIN
  SELECT id INTO v_anchor_id
  FROM anchors
  WHERE public_id = p_public_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Walk descendants to the current head. Cap at 100 hops.
  WITH RECURSIVE walk AS (
    SELECT id, 1 AS hop
    FROM anchors
    WHERE id = v_anchor_id
    UNION ALL
    SELECT a.id, walk.hop + 1
    FROM anchors a
    INNER JOIN walk ON a.parent_anchor_id = walk.id
    WHERE walk.hop < 100 AND a.deleted_at IS NULL
  )
  -- Deterministic tie-break: if the tree ever forks (rejected on insert, but
  -- historical data may have them), always pick the same leaf across reads.
  SELECT walk.id INTO v_current_id
  FROM walk
  INNER JOIN anchors a ON a.id = walk.id
  ORDER BY walk.hop DESC, a.created_at DESC, a.id ASC
  LIMIT 1;

  SELECT public_id INTO v_current_public_id
  FROM anchors
  WHERE id = v_current_id;

  RETURN v_current_public_id;
END;
$$;


ALTER FUNCTION "public"."get_current_anchor_public_id"("p_public_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_current_anchor_public_id"("p_public_id" "text") IS 'ARK-104: given any public_id in a lineage, return the CURRENT head public_id. The verify page uses this so a stale ATS/VMS link still resolves to the up-to-date credential.';



CREATE OR REPLACE FUNCTION "public"."get_distinct_record_types"() RETURNS TABLE("record_type" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT elem::text
  FROM pipeline_dashboard_cache pdc, LATERAL jsonb_array_elements_text(pdc.cache_value) AS elem
  WHERE pdc.cache_key = 'record_types';
END;
$$;


ALTER FUNCTION "public"."get_distinct_record_types"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_edgar_shard_counts"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."get_edgar_shard_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_extraction_accuracy"("p_credential_type" "text" DEFAULT NULL::"text", "p_org_id" "uuid" DEFAULT NULL::"uuid", "p_days" integer DEFAULT 30) RETURNS TABLE("credential_type" "text", "field_key" "text", "total_suggestions" bigint, "accepted_count" bigint, "rejected_count" bigint, "edited_count" bigint, "acceptance_rate" numeric, "avg_confidence" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ef.credential_type,
    ef.field_key,
    COUNT(*) AS total_suggestions,
    COUNT(*) FILTER (WHERE ef.action = 'accepted') AS accepted_count,
    COUNT(*) FILTER (WHERE ef.action = 'rejected') AS rejected_count,
    COUNT(*) FILTER (WHERE ef.action = 'edited') AS edited_count,
    ROUND(
      COUNT(*) FILTER (WHERE ef.action = 'accepted')::numeric / NULLIF(COUNT(*), 0) * 100,
      2
    ) AS acceptance_rate,
    ROUND(AVG(ef.original_confidence), 3) AS avg_confidence
  FROM extraction_feedback ef
  WHERE ef.created_at >= now() - (p_days || ' days')::interval
    AND (p_credential_type IS NULL OR ef.credential_type = p_credential_type)
    AND (p_org_id IS NULL OR ef.org_id = p_org_id)
  GROUP BY ef.credential_type, ef.field_key
  ORDER BY total_suggestions DESC;
END;
$$;


ALTER FUNCTION "public"."get_extraction_accuracy"("p_credential_type" "text", "p_org_id" "uuid", "p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_flag"("p_flag_key" "text", "p_default" boolean DEFAULT false) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled
  FROM switchboard_flags
  WHERE flag_key = p_flag_key;

  IF NOT FOUND THEN
    RETURN p_default;
  END IF;

  RETURN v_enabled;
END;
$$;


ALTER FUNCTION "public"."get_flag"("p_flag_key" "text", "p_default" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_credentials"() RETURNS TABLE("recipient_id" "uuid", "anchor_id" "uuid", "claimed_at" timestamp with time zone, "recipient_created_at" timestamp with time zone, "public_id" "text", "filename" "text", "fingerprint" "text", "status" "text", "credential_type" "text", "metadata" "jsonb", "issued_at" timestamp with time zone, "expires_at" timestamp with time zone, "created_at" timestamp with time zone, "org_name" "text", "org_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ SELECT ar.id, ar.anchor_id, ar.claimed_at, ar.created_at, a.public_id, a.filename, a.fingerprint, a.status::text, a.credential_type::text, a.metadata, a.issued_at, a.expires_at, a.created_at, o.display_name, a.org_id FROM anchor_recipients ar JOIN anchors a ON a.id = ar.anchor_id LEFT JOIN organizations o ON o.id = a.org_id WHERE ar.recipient_user_id = auth.uid() AND a.deleted_at IS NULL ORDER BY a.created_at DESC; $$;


ALTER FUNCTION "public"."get_my_credentials"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'total', COUNT(*) FILTER (WHERE TRUE),
    'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
    'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
  )
  FROM anchors
  WHERE org_id = p_org_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;
$$;


ALTER FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_org_credit_summary"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_row    org_credits%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('error', 'not_a_member');
  END IF;

  SELECT * INTO v_row FROM org_credits WHERE org_id = p_org_id;
  IF v_row.org_id IS NULL THEN
    RETURN jsonb_build_object(
      'org_id', p_org_id,
      'balance', 0, 'monthly_allocation', 0, 'purchased', 0,
      'cycle_start', null, 'cycle_end', null, 'initialized', false
    );
  END IF;

  RETURN jsonb_build_object(
    'org_id', v_row.org_id,
    'balance', v_row.balance,
    'monthly_allocation', v_row.monthly_allocation,
    'purchased', v_row.purchased,
    'cycle_start', v_row.cycle_start,
    'cycle_end', v_row.cycle_end,
    'initialized', true
  );
END;
$$;


ALTER FUNCTION "public"."get_org_credit_summary"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_org_members_public"("p_org_id" "uuid", "p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '5s'
    AS $$
DECLARE
  result jsonb;
  total_count bigint;
  members jsonb;
  effective_limit integer;
  effective_offset integer;
BEGIN
  effective_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  effective_offset := greatest(0, coalesce(p_offset, 0));

  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_org_id) THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;

  SELECT count(*)
  INTO total_count
  FROM org_members
  WHERE org_id = p_org_id;

  SELECT coalesce(jsonb_agg(member ORDER BY ord_role, ord_name), '[]'::jsonb)
  INTO members
  FROM (
    SELECT
      jsonb_build_object(
        'profile_public_id',
          CASE WHEN coalesce(p.is_public_profile, false) THEN p.public_id ELSE NULL END,
        'display_name',
          CASE
            WHEN coalesce(p.is_public_profile, false)
              THEN coalesce(nullif(p.full_name, ''), 'Public member')
            ELSE anonymize_member_display_name(p.full_name)
          END,
        'avatar_url',
          CASE WHEN coalesce(p.is_public_profile, false) THEN p.avatar_url ELSE NULL END,
        'role', om.role,
        'is_public_profile', coalesce(p.is_public_profile, false)
      ) AS member,
      CASE om.role
        WHEN 'owner' THEN 1
        WHEN 'admin' THEN 2
        ELSE 3
      END AS ord_role,
      CASE
        WHEN coalesce(p.is_public_profile, false)
          THEN coalesce(p.full_name, p.public_id)
        ELSE p.public_id
      END AS ord_name
    FROM org_members om
    JOIN profiles p ON p.id = om.user_id
    WHERE om.org_id = p_org_id
    ORDER BY ord_role, ord_name
    LIMIT effective_limit
    OFFSET effective_offset
  ) sub;

  result := jsonb_build_object(
    'org_id', p_org_id,
    'total', total_count,
    'limit', effective_limit,
    'offset', effective_offset,
    'members', members
  );
  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_org_members_public"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_org_subtree"("p_root_id" "uuid", "p_max_depth" integer DEFAULT 3) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '5s'
    AS $$
DECLARE
  effective_depth integer := greatest(1, least(coalesce(p_max_depth, 3), 3));
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_root_id) THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;
  WITH RECURSIVE tree AS (
    SELECT
      o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
      o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
      o.org_type, o.website_url, o.verification_status,
      o.verified_badge_granted_at, 1 AS depth
    FROM organizations o WHERE o.id = p_root_id
    UNION ALL
    SELECT
      o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
      o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
      o.org_type, o.website_url, o.verification_status,
      o.verified_badge_granted_at, t.depth + 1
    FROM organizations o JOIN tree t ON t.id = o.parent_org_id
    WHERE t.depth < effective_depth
      AND coalesce(o.parent_approval_status, 'APPROVED') = 'APPROVED'
  )
  SELECT jsonb_build_object(
    'root_id', p_root_id,
    'max_depth', effective_depth,
    'nodes', coalesce(jsonb_agg(jsonb_build_object(
      'org_id', t.id, 'public_id', t.public_id,
      'parent_org_id', t.parent_org_id,
      'display_name', t.display_name, 'domain', t.domain,
      'description', t.description, 'logo_url', t.logo_url,
      'banner_url', t.banner_url, 'org_type', t.org_type,
      'website_url', t.website_url,
      'verification_status', t.verification_status,
      'verified_badge_granted_at', t.verified_badge_granted_at,
      'depth', t.depth
    ) ORDER BY t.depth, t.display_name), '[]'::jsonb)
  ) INTO result FROM tree t;
  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_org_subtree"("p_root_id" "uuid", "p_max_depth" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_parent_credit_rollup"("p_parent_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_parent_balance integer;
  v_children jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('error', 'authentication_required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('error', 'parent_admin_required');
  END IF;

  SELECT balance INTO v_parent_balance FROM org_credits WHERE org_id = p_parent_org_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'child_org_id', o.id,
    'balance', coalesce(c.balance, 0),
    'monthly_allocation', coalesce(c.monthly_allocation, 0)
  )), '[]'::jsonb) INTO v_children
  FROM organizations o
  LEFT JOIN org_credits c ON c.org_id = o.id
  WHERE o.parent_org_id = p_parent_org_id;

  RETURN jsonb_build_object(
    'parent_org_id', p_parent_org_id,
    'parent_balance', coalesce(v_parent_balance, 0),
    'children', v_children
  );
END;
$$;


ALTER FUNCTION "public"."get_parent_credit_rollup"("p_parent_org_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_usage_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid",
    "user_id" "uuid",
    "event_type" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "tokens_used" integer DEFAULT 0,
    "credits_consumed" integer DEFAULT 1 NOT NULL,
    "fingerprint" "text",
    "confidence" numeric(4,3),
    "duration_ms" integer,
    "success" boolean DEFAULT true NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "prompt_version" "text",
    "result_json" "jsonb",
    CONSTRAINT "ai_usage_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['extraction'::"text", 'embedding'::"text", 'fraud_check'::"text"])))
);

ALTER TABLE ONLY "public"."ai_usage_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."ai_usage_events"."prompt_version" IS 'SHA-256 hash prefix (12 chars) of the extraction prompt used';



COMMENT ON COLUMN "public"."ai_usage_events"."result_json" IS 'Cached extraction result fields for EFF-1 cache-by-fingerprint optimization';



CREATE TABLE IF NOT EXISTS "public"."billing_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stripe_event_id" "text",
    "event_type" "text" NOT NULL,
    "user_id" "uuid",
    "org_id" "uuid",
    "subscription_id" "uuid",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "processed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "idempotency_key" "text"
);

ALTER TABLE ONLY "public"."billing_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."billing_events" IS 'Append-only audit trail for billing events';



CREATE TABLE IF NOT EXISTS "public"."x402_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tx_hash" "text" NOT NULL,
    "network" "text" NOT NULL,
    "amount_usd" numeric(10,6) NOT NULL,
    "payer_address" "text" NOT NULL,
    "payee_address" "text" NOT NULL,
    "token" "text" DEFAULT 'USDC'::"text" NOT NULL,
    "facilitator_url" "text" NOT NULL,
    "verification_request_id" "uuid",
    "raw_response" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "org_id" "uuid",
    "verified" boolean DEFAULT false NOT NULL,
    "verified_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."x402_payments" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."x402_payments" OWNER TO "postgres";


COMMENT ON TABLE "public"."x402_payments" IS 'Tracks x402 pay-per-request settlements for verification API';



COMMENT ON COLUMN "public"."x402_payments"."org_id" IS 'SCRUM-1280: scope x402 payments to the paying org. NULL is grandfathered for pre-2026-04-28 rows.';



COMMENT ON COLUMN "public"."x402_payments"."verified" IS 'SCRUM-1280: only payments confirmed by the x402 facilitator count as authorization.';



CREATE OR REPLACE VIEW "public"."payment_ledger" WITH ("security_invoker"='true') AS
 SELECT ("be"."id")::"text" AS "ledger_id",
    'stripe'::"text" AS "source",
    "be"."event_type",
    "be"."stripe_event_id" AS "external_id",
    COALESCE(((("be"."payload" ->> 'amount_total'::"text"))::numeric / (100)::numeric), (0)::numeric) AS "amount_usd",
    'USD'::"text" AS "currency",
    "be"."user_id",
    NULL::"uuid" AS "org_id",
    "be"."processed_at" AS "event_at",
    "be"."payload" AS "details"
   FROM "public"."billing_events" "be"
  WHERE ("be"."event_type" = ANY (ARRAY['checkout.session.completed'::"text", 'invoice.payment_succeeded'::"text"]))
UNION ALL
 SELECT ("xp"."id")::"text" AS "ledger_id",
    'x402'::"text" AS "source",
    'x402.payment'::"text" AS "event_type",
    "xp"."tx_hash" AS "external_id",
    "xp"."amount_usd",
    'USDC'::"text" AS "currency",
    NULL::"uuid" AS "user_id",
    NULL::"uuid" AS "org_id",
    "xp"."created_at" AS "event_at",
    "jsonb_build_object"('network', "xp"."network", 'token', "xp"."token", 'verification_request_id', "xp"."verification_request_id") AS "details"
   FROM "public"."x402_payments" "xp"
UNION ALL
 SELECT ("aue"."id")::"text" AS "ledger_id",
    'ai_credits'::"text" AS "source",
    "aue"."event_type",
    NULL::"text" AS "external_id",
    (("aue"."credits_consumed")::numeric * 0.01) AS "amount_usd",
    'CREDITS'::"text" AS "currency",
    "aue"."user_id",
    "aue"."org_id",
    "aue"."created_at" AS "event_at",
    "jsonb_build_object"('provider', "aue"."provider", 'fingerprint', "aue"."fingerprint", 'tokens_used', "aue"."tokens_used") AS "details"
   FROM "public"."ai_usage_events" "aue";


ALTER VIEW "public"."payment_ledger" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_payment_ledger"("p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0) RETURNS SETOF "public"."payment_ledger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NOT (
    get_caller_role() = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN QUERY
  SELECT * FROM payment_ledger
  ORDER BY event_at DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET p_offset;
END;
$$;


ALTER FUNCTION "public"."get_payment_ledger"("p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_pending_user_anchors"("p_limit" integer DEFAULT 100) RETURNS TABLE("id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT a.id
  FROM anchors a
  WHERE a.status = 'PENDING'
    AND a.deleted_at IS NULL
    AND (a.metadata->>'pipeline_source') IS NULL
  ORDER BY a.created_at ASC
  LIMIT p_limit;
$$;


ALTER FUNCTION "public"."get_pending_user_anchors"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_pipeline_stats"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_cached jsonb;
  v_updated_at timestamptz;
  v_total bigint;
  v_embedded bigint;
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF;

  SELECT cache_value, updated_at INTO v_cached, v_updated_at
  FROM pipeline_dashboard_cache
  WHERE cache_key = 'pipeline_stats';

  IF v_cached IS NOT NULL THEN
    RETURN (v_cached || jsonb_build_object('cache_updated_at', v_updated_at))::json;
  END IF;

  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'public_records';
  SELECT reltuples::bigint INTO v_embedded FROM pg_class WHERE relname = 'public_record_embeddings';
  RETURN json_build_object(
    'total_records', COALESCE(v_total, 0),
    'anchor_linked_records', 0,
    'pending_record_links', COALESCE(v_total, 0),
    'bitcoin_anchored_records', 0,
    'pending_bitcoin_records', COALESCE(v_total, 0),
    'pending_anchor_records', 0,
    'broadcasting_records', 0,
    'submitted_records', 0,
    'secured_records', 0,
    'embedded_records', COALESCE(v_embedded, 0),
    'cache_miss', true
  );
END;
$$;


ALTER FUNCTION "public"."get_pipeline_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_anchor"("p_public_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_result jsonb;
  v_recipient_hash text;
  v_recipient_raw text;
BEGIN
  SELECT
    a.metadata->>'recipient',
    jsonb_build_object(
      'verified', a.status = 'SECURED',
      'status', CASE a.status
        WHEN 'SECURED' THEN 'ACTIVE'
        WHEN 'REVOKED' THEN 'REVOKED'
        WHEN 'EXPIRED' THEN 'EXPIRED'
        WHEN 'PENDING' THEN 'PENDING'
        WHEN 'SUBMITTED' THEN 'SUBMITTED'
        ELSE a.status::text
      END,
      'issuer_name', COALESCE(a.metadata->>'issuer', o.display_name, 'Unknown Issuer'),
      'credential_type', COALESCE(a.credential_type::text, 'OTHER'),
      'issued_date', a.issued_at,
      'expiry_date', a.expires_at,
      'anchor_timestamp', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_timestamp END,
      'bitcoin_block', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_block_height END,
      'network_receipt_id', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_tx_id END,
      'merkle_proof_hash', NULL::text,
      'record_uri', 'https://app.arkova.io/verify/' || a.public_id,
      'public_id', a.public_id,
      'fingerprint', a.fingerprint,
      'filename', a.filename,
      'file_size', a.file_size,
      'org_id', a.org_id,
      'metadata', sanitize_metadata_for_public(COALESCE(a.metadata, '{}'::jsonb)),
      'created_at', a.created_at,
      'secured_at', CASE WHEN a.status NOT IN ('PENDING') THEN a.chain_timestamp END,
      'issued_at', a.issued_at,
      'revoked_at', a.revoked_at,
      'revocation_reason', a.revocation_reason,
      'expires_at', a.expires_at
    )
    || CASE
         WHEN a.metadata->>'jurisdiction' IS NOT NULL
         THEN jsonb_build_object('jurisdiction', a.metadata->>'jurisdiction')
         ELSE '{}'::jsonb
       END
  INTO
    v_recipient_raw,
    v_result
  FROM anchors a
  LEFT JOIN organizations o ON o.id = a.org_id
  WHERE a.public_id = p_public_id
    AND a.status IN ('SECURED', 'REVOKED', 'EXPIRED', 'PENDING', 'SUBMITTED')
    AND a.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Record not found');
  END IF;

  IF v_recipient_raw IS NOT NULL AND v_recipient_raw != '' THEN
    v_recipient_hash := encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex');
    v_result := v_result || jsonb_build_object('recipient_identifier', v_recipient_hash);
  ELSE
    v_result := v_result || jsonb_build_object('recipient_identifier', '');
  END IF;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."get_public_anchor"("p_public_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_public_anchor"("p_public_id" "text") IS 'Returns redacted anchor info for public verification (Phase 1.5 frozen schema). Returns SECURED, REVOKED, EXPIRED, PENDING, SUBMITTED. PENDING is exposed with verified=false so the public page can show "awaiting confirmation" instead of "not found".';



CREATE OR REPLACE FUNCTION "public"."get_public_issuer_registry"("p_org_id" "uuid", "p_limit" integer DEFAULT 20, "p_offset" integer DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  result jsonb;
  org_row record;
  total_count bigint;
  anchors_list jsonb;
  has_public_admin boolean;
BEGIN
  SELECT id, display_name, domain, description, logo_url
  INTO org_row
  FROM organizations
  WHERE id = p_org_id;

  IF org_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Issuer not found');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE org_id = p_org_id
      AND role = 'ORG_ADMIN'
      AND is_public_profile = true
  ) INTO has_public_admin;

  IF NOT has_public_admin THEN
    RETURN jsonb_build_object('error', 'Issuer profile is not public');
  END IF;

  SELECT count(*)
  INTO total_count
  FROM anchors
  WHERE org_id = p_org_id
    AND status = 'SECURED'
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;

  SELECT coalesce(jsonb_agg(row_to_json(a)::jsonb ORDER BY a.created_at DESC), '[]'::jsonb)
  INTO anchors_list
  FROM (
    SELECT id, public_id, filename, fingerprint, credential_type,
           status, created_at, chain_timestamp, chain_tx_id
    FROM anchors
    WHERE org_id = p_org_id
      AND status = 'SECURED'
      AND deleted_at IS NULL
      AND (metadata->>'pipeline_source') IS NULL
    ORDER BY created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) a;

  result := jsonb_build_object(
    'org', jsonb_build_object(
      'id', org_row.id,
      'display_name', org_row.display_name,
      'domain', org_row.domain,
      'description', org_row.description,
      'logo_url', org_row.logo_url
    ),
    'total', total_count,
    'anchors', anchors_list
  );

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_public_issuer_registry"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_member_profile"("p_public_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  profile_row record;
  orgs jsonb;
BEGIN
  SELECT id, public_id, full_name, avatar_url, bio, social_links, created_at
  INTO profile_row
  FROM profiles
  WHERE public_id = p_public_id
    AND is_public_profile;

  IF profile_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Profile not found');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'org_id', o.id,
    'public_id', o.public_id,
    'display_name', o.display_name,
    'domain', o.domain,
    'logo_url', o.logo_url,
    'verification_status', o.verification_status,
    'role', om.role
  ) ORDER BY o.display_name), '[]'::jsonb)
  INTO orgs
  FROM org_members om
  JOIN organizations o ON o.id = om.org_id
  WHERE om.user_id = profile_row.id;

  RETURN jsonb_build_object(
    'public_id', profile_row.public_id,
    'display_name', coalesce(nullif(profile_row.full_name, ''), 'Public member'),
    'avatar_url', profile_row.avatar_url,
    'bio', profile_row.bio,
    'social_links', profile_row.social_links,
    'created_at', profile_row.created_at,
    'organizations', orgs
  );
END;
$$;


ALTER FUNCTION "public"."get_public_member_profile"("p_public_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_org_profile"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  result jsonb;
  org_row record;
  total_count bigint;
  secured_count bigint;
  breakdown jsonb;
  members jsonb;
  sub_orgs jsonb;
BEGIN
  SELECT id, public_id, display_name, domain, description, org_type,
         website_url, linkedin_url, twitter_url, logo_url,
         location, founded_date, industry_tag, verification_status, created_at
  INTO org_row
  FROM organizations
  WHERE id = p_org_id;

  IF org_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE status = 'SECURED')
  INTO total_count, secured_count
  FROM anchors
  WHERE org_id = p_org_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'type', credential_type,
    'count', cnt
  ) ORDER BY cnt DESC), '[]'::jsonb)
  INTO breakdown
  FROM (
    SELECT credential_type, count(*) AS cnt
    FROM anchors
    WHERE org_id = p_org_id
      AND deleted_at IS NULL
      AND (metadata->>'pipeline_source') IS NULL
    GROUP BY credential_type
  ) sub;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'profile_public_id', CASE WHEN coalesce(p.is_public_profile, false) THEN p.public_id ELSE NULL END,
    'display_name', CASE
      WHEN coalesce(p.is_public_profile, false) THEN coalesce(nullif(p.full_name, ''), 'Public member')
      ELSE 'Anonymous member'
    END,
    'avatar_url', CASE WHEN coalesce(p.is_public_profile, false) THEN p.avatar_url ELSE NULL END,
    'role', om.role,
    'is_public_profile', coalesce(p.is_public_profile, false)
  ) ORDER BY
    CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
    CASE WHEN coalesce(p.is_public_profile, false) THEN coalesce(p.full_name, p.public_id) ELSE p.public_id END
  ), '[]'::jsonb)
  INTO members
  FROM org_members om
  JOIN profiles p ON p.id = om.user_id
  WHERE om.org_id = p_org_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'org_id', child.id,
    'public_id', child.public_id,
    'display_name', child.display_name,
    'domain', child.domain,
    'description', child.description,
    'logo_url', child.logo_url,
    'org_type', child.org_type,
    'website_url', child.website_url,
    'verification_status', child.verification_status
  ) ORDER BY child.display_name), '[]'::jsonb)
  INTO sub_orgs
  FROM organizations child
  WHERE child.parent_org_id = p_org_id
    AND child.parent_approval_status = 'APPROVED';

  result := jsonb_build_object(
    'org_id', org_row.id,
    'public_id', org_row.public_id,
    'display_name', org_row.display_name,
    'domain', org_row.domain,
    'description', org_row.description,
    'org_type', org_row.org_type,
    'website_url', org_row.website_url,
    'linkedin_url', org_row.linkedin_url,
    'twitter_url', org_row.twitter_url,
    'logo_url', org_row.logo_url,
    'location', org_row.location,
    'founded_date', org_row.founded_date,
    'industry_tag', org_row.industry_tag,
    'verification_status', org_row.verification_status,
    'created_at', org_row.created_at,
    'total_credentials', total_count,
    'secured_credentials', secured_count,
    'credential_breakdown', breakdown,
    'public_members', members,
    'sub_organizations', sub_orgs
  );

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_public_org_profile"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_org_profiles"("p_org_id" "uuid" DEFAULT NULL::"uuid", "p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" "uuid", "display_name" "text", "domain" "text", "description" "text", "website_url" "text", "logo_url" "text", "founded_date" "date", "org_type" "text", "linkedin_url" "text", "twitter_url" "text", "location" "text", "industry_tag" "text", "verification_status" "text", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id,
    o.display_name,
    o.domain,
    o.description,
    o.website_url,
    o.logo_url,
    o.founded_date,
    o.org_type,
    o.linkedin_url,
    o.twitter_url,
    o.location,
    o.industry_tag,
    o.verification_status,
    o.created_at
  FROM organizations o
  WHERE (p_org_id IS NULL OR o.id = p_org_id)
  ORDER BY o.created_at DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET p_offset;
END;
$$;


ALTER FUNCTION "public"."get_public_org_profiles"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_records_page"("p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 20, "p_source" "text" DEFAULT NULL::"text", "p_record_type" "text" DEFAULT NULL::"text", "p_anchor_status" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_offset integer;
  v_total bigint;
  v_data json;
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  v_offset := (p_page - 1) * p_page_size;

  -- Use approximate total for pagination (instant)
  v_total := (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records');

  SELECT json_agg(row_to_json(t))
  INTO v_data
  FROM (
    SELECT id, title, source, record_type, anchor_id, created_at, content_hash
    FROM public_records
    WHERE (p_source IS NULL OR source = p_source)
      AND (p_record_type IS NULL OR record_type = p_record_type)
      AND (p_anchor_status IS NULL
           OR (p_anchor_status = 'anchored' AND anchor_id IS NOT NULL)
           OR (p_anchor_status = 'unanchored' AND anchor_id IS NULL))
    ORDER BY created_at DESC
    LIMIT p_page_size
    OFFSET v_offset
  ) t;

  RETURN json_build_object(
    'data', COALESCE(v_data, '[]'::json),
    'total', v_total,
    'page', p_page,
    'page_size', p_page_size
  );
END;
$$;


ALTER FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_records_page"("p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 20, "p_source" "text" DEFAULT NULL::"text", "p_record_type" "text" DEFAULT NULL::"text", "p_anchor_status" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_offset integer;
  v_total bigint;
  v_data json;
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  v_offset := GREATEST(p_page - 1, 0) * p_page_size;

  IF p_source IS NULL AND p_record_type IS NULL AND p_anchor_status IS NULL AND v_search IS NULL THEN
    v_total := (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records');
  ELSE
    SELECT count(*) INTO v_total
    FROM public_records pr
    LEFT JOIN anchors a ON a.id = pr.anchor_id
    WHERE (p_source IS NULL OR pr.source = p_source)
      AND (p_record_type IS NULL OR pr.record_type = p_record_type)
      AND (
        p_anchor_status IS NULL
        OR (
          p_anchor_status = 'anchored'
          AND a.status IN ('SUBMITTED', 'SECURED')
          AND a.chain_tx_id IS NOT NULL
        )
        OR (
          p_anchor_status = 'unanchored'
          AND (
            pr.anchor_id IS NULL
            OR a.id IS NULL
            OR a.status NOT IN ('SUBMITTED', 'SECURED')
            OR a.chain_tx_id IS NULL
          )
        )
      )
      AND (
        v_search IS NULL
        OR pr.title ILIKE '%' || v_search || '%'
        OR pr.source_id ILIKE '%' || v_search || '%'
        OR pr.content_hash ILIKE v_search || '%'
      );
  END IF;

  SELECT json_agg(row_to_json(t))
  INTO v_data
  FROM (
    SELECT
      pr.id,
      pr.title,
      pr.source,
      pr.source_id,
      pr.source_url,
      pr.record_type,
      pr.anchor_id,
      pr.metadata,
      pr.created_at,
      pr.updated_at,
      pr.content_hash,
      a.status::text AS anchor_status,
      a.chain_tx_id
    FROM public_records pr
    LEFT JOIN anchors a ON a.id = pr.anchor_id
    WHERE (p_source IS NULL OR pr.source = p_source)
      AND (p_record_type IS NULL OR pr.record_type = p_record_type)
      AND (
        p_anchor_status IS NULL
        OR (
          p_anchor_status = 'anchored'
          AND a.status IN ('SUBMITTED', 'SECURED')
          AND a.chain_tx_id IS NOT NULL
        )
        OR (
          p_anchor_status = 'unanchored'
          AND (
            pr.anchor_id IS NULL
            OR a.id IS NULL
            OR a.status NOT IN ('SUBMITTED', 'SECURED')
            OR a.chain_tx_id IS NULL
          )
        )
      )
      AND (
        v_search IS NULL
        OR pr.title ILIKE '%' || v_search || '%'
        OR pr.source_id ILIKE '%' || v_search || '%'
        OR pr.content_hash ILIKE v_search || '%'
      )
    ORDER BY pr.created_at DESC
    LIMIT p_page_size
    OFFSET v_offset
  ) t;

  RETURN json_build_object(
    'data', COALESCE(v_data, '[]'::json),
    'total', COALESCE(v_total, 0),
    'page', p_page,
    'page_size', p_page_size
  );
END;
$$;


ALTER FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text", "p_search" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_records_stats"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NOT (
    current_setting('request.jwt.claims', true)::json->>'role' = 'service_role'
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'Access denied: platform admin required';
  END IF;

  RETURN (
    SELECT json_build_object(
      'total', (SELECT reltuples::bigint FROM pg_class WHERE relname = 'public_records'),
      'by_source', (
        SELECT json_agg(row_to_json(t))
        FROM (
          SELECT source, count(*) as count
          FROM public_records
          GROUP BY source
          ORDER BY count DESC
        ) t
      ),
      'by_type', (
        SELECT json_agg(row_to_json(t))
        FROM (
          SELECT record_type, count(*) as count
          FROM public_records
          GROUP BY record_type
          ORDER BY count DESC
          LIMIT 20
        ) t
      )
    )
  );
END;
$$;


ALTER FUNCTION "public"."get_public_records_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_template"("p_credential_type" "text", "p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'name', ct.name,
    'default_metadata', ct.default_metadata
  )
  INTO v_result
  FROM credential_templates ct
  WHERE ct.org_id = p_org_id
    AND ct.credential_type = p_credential_type::credential_type
    AND ct.is_active = true
  LIMIT 1;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."get_public_template"("p_credential_type" "text", "p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_recent_cron_failures"("since_minutes" integer) RETURNS TABLE("jobid" integer, "jobname" "text", "return_message" "text", "start_time" timestamp with time zone, "end_time" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    jrd.jobid::int,
    j.jobname::text,
    jrd.return_message::text,
    jrd.start_time,
    jrd.end_time
  FROM cron.job_run_details jrd
  LEFT JOIN cron.job j ON j.jobid = jrd.jobid
  WHERE jrd.status = 'failed'
    AND jrd.start_time >= now() - (since_minutes * interval '1 minute')
  ORDER BY jrd.start_time DESC;
$$;


ALTER FUNCTION "public"."get_recent_cron_failures"("since_minutes" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_recent_cron_failures"("since_minutes" integer) IS 'SCRUM-1307: Returns pg_cron job failures within the last N minutes. Used by db-health-monitor (SCRUM-1254) to detect and page on cron failures.';



CREATE OR REPLACE FUNCTION "public"."get_source_date_range"("p_source" "text", "p_date_field" "text" DEFAULT 'date_filed'::"text") RETURNS json
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT json_build_object(
    'min_date', MIN(metadata->>p_date_field),
    'max_date', MAX(metadata->>p_date_field),
    'count', COUNT(*)
  )
  FROM public_records
  WHERE source = p_source;
$$;


ALTER FUNCTION "public"."get_source_date_range"("p_source" "text", "p_date_field" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_table_bloat_stats"("table_names" "text"[]) RETURNS TABLE("schemaname" "text", "relname" "text", "n_live_tup" bigint, "n_dead_tup" bigint, "last_autovacuum" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    pst.schemaname::text,
    pst.relname::text,
    pst.n_live_tup,
    pst.n_dead_tup,
    pst.last_autovacuum
  FROM pg_stat_user_tables pst
  WHERE pst.schemaname = 'public'
    AND pst.relname = ANY(table_names)
  ORDER BY pst.n_dead_tup DESC;
$$;


ALTER FUNCTION "public"."get_table_bloat_stats"("table_names" "text"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_table_bloat_stats"("table_names" "text"[]) IS 'SCRUM-1307: Returns dead-tuple and autovacuum stats for specified public tables. Used by db-health-monitor (SCRUM-1254) to detect bloat and stale autovacuum.';



CREATE OR REPLACE FUNCTION "public"."get_treasury_stats"() RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ BEGIN IF NOT (current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_admin = true)) THEN RAISE EXCEPTION 'Access denied: platform admin required'; END IF; RETURN (SELECT json_build_object('total_payments', (SELECT count(*) FROM x402_payments), 'total_revenue_usd', (SELECT COALESCE(sum(amount_usd), 0) FROM x402_payments), 'recent_payments', (SELECT json_agg(row_to_json(t)) FROM (SELECT tx_hash, amount_usd, created_at FROM x402_payments ORDER BY created_at DESC LIMIT 5) t))); END; $$;


ALTER FUNCTION "public"."get_treasury_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_unembedded_public_records"("p_limit" integer DEFAULT 100) RETURNS TABLE("id" "uuid", "title" "text", "source" "text", "record_type" "text", "metadata" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT pr.id, pr.title, pr.source, pr.record_type, pr.metadata
  FROM public_records pr
  LEFT JOIN public_record_embeddings pre ON pre.public_record_id = pr.id
  WHERE pre.id IS NULL
  ORDER BY pr.created_at ASC
  LIMIT p_limit;
$$;


ALTER FUNCTION "public"."get_unembedded_public_records"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'total', COUNT(*) FILTER (WHERE TRUE),
    'secured', COUNT(*) FILTER (WHERE status = 'SECURED'),
    'pending', COUNT(*) FILTER (WHERE status = 'PENDING')
  )
  FROM anchors
  WHERE user_id = p_user_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;
$$;


ALTER FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_credits"("p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_credits credits%ROWTYPE;
  v_plan_name text;
  v_plan_allocation integer;
BEGIN
  v_user_id := COALESCE(p_user_id, auth.uid());
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found');
  END IF;

  SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;

  SELECT p.name, CASE p.name
    WHEN 'Free' THEN 50
    WHEN 'Individual' THEN 500
    WHEN 'Professional' THEN 5000
    ELSE 50
  END
  INTO v_plan_name, v_plan_allocation
  FROM subscriptions s
  JOIN plans p ON s.plan_id = p.id
  WHERE s.user_id = v_user_id
    AND s.status IN ('active', 'trialing')
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_plan_name IS NULL THEN
    v_plan_name := 'Free';
    v_plan_allocation := 50;
  END IF;

  IF v_credits.id IS NULL THEN
    INSERT INTO credits (user_id, balance, monthly_allocation, cycle_start, cycle_end)
    VALUES (
      v_user_id,
      v_plan_allocation,
      v_plan_allocation,
      date_trunc('month', now()),
      (date_trunc('month', now()) + interval '1 month')
    )
    ON CONFLICT (user_id) DO NOTHING
    RETURNING * INTO v_credits;

    IF v_credits.id IS NULL THEN
      SELECT * INTO v_credits FROM credits WHERE user_id = v_user_id;
    END IF;

    INSERT INTO credit_transactions (user_id, transaction_type, amount, balance_after, reason)
    VALUES (v_user_id, 'ALLOCATION', v_plan_allocation, v_plan_allocation, 'Initial credit allocation');
  END IF;

  RETURN jsonb_build_object(
    'balance', v_credits.balance,
    'monthly_allocation', v_plan_allocation,
    'purchased', v_credits.purchased,
    'plan_name', v_plan_name,
    'cycle_start', v_credits.cycle_start,
    'cycle_end', v_credits.cycle_end,
    'is_low', v_credits.balance < 10
  );
END;
$$;


ALTER FUNCTION "public"."get_user_credits"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must match auth.uid()'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO v_count FROM anchors
  WHERE user_id = p_user_id
    AND created_at >= date_trunc('month', now());

  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") IS 'BUG-2026-04-19-001: count of this-month anchors for the calling user. SECURITY DEFINER bypasses RLS. RAISES 42501 if p_user_id != auth.uid().';



CREATE OR REPLACE FUNCTION "public"."get_user_org_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT org_id FROM profiles WHERE id = auth.uid();
$$;


ALTER FUNCTION "public"."get_user_org_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_user_org_id"() IS 'Returns the org_id for the current authenticated user';



CREATE OR REPLACE FUNCTION "public"."get_user_org_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid();
$$;


ALTER FUNCTION "public"."get_user_org_ids"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_user_org_ids"() IS 'Returns all org IDs the current user belongs to';



CREATE OR REPLACE FUNCTION "public"."handle_auth_user_email_verified_org_join"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
BEGIN
  IF NEW.email IS NULL OR NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM auto_associate_profile_to_org_by_email_domain(NEW.id, NEW.email);
    RETURN NEW;
  END IF;

  IF OLD.email_confirmed_at IS NULL OR lower(COALESCE(OLD.email, '')) IS DISTINCT FROM lower(NEW.email) THEN
    PERFORM auto_associate_profile_to_org_by_email_domain(NEW.id, NEW.email);
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_auth_user_email_verified_org_join"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, subscription_tier, status, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'free',
    'ACTIVE',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_org_usage"("p_org_id" "uuid", "p_quota_kind" "text", "p_delta" bigint DEFAULT 1) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'UTC')::date;
  v_count BIGINT;
BEGIN
  INSERT INTO org_daily_usage (org_id, usage_date, quota_kind, count, updated_at)
  VALUES (p_org_id, v_today, p_quota_kind, GREATEST(p_delta, 0), now())
  ON CONFLICT (org_id, usage_date, quota_kind)
  DO UPDATE SET
    count = org_daily_usage.count + EXCLUDED.count,
    updated_at = now()
  RETURNING count INTO v_count;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."increment_org_usage"("p_org_id" "uuid", "p_quota_kind" "text", "p_delta" bigint) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."increment_org_usage"("p_org_id" "uuid", "p_quota_kind" "text", "p_delta" bigint) IS 'SCALE-01 atomic usage counter bump. Returns the new value. Rollover is implicit — a new UTC day inserts a new row.';



CREATE OR REPLACE FUNCTION "public"."invite_member"("invitee_email" "text", "invitee_role" "public"."user_role", "target_org_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  caller_profile RECORD;
  new_invite_id uuid;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only ORG_ADMIN can invite members'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF caller_profile.org_id != target_org_id THEN
    RAISE EXCEPTION 'Cannot invite to a different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- SEC-RECON-8: Block inviting as ORG_ADMIN — privilege escalation vector
  IF invitee_role = 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Cannot invite as ORG_ADMIN. Invite as ORG_MEMBER and promote via admin panel.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO invitations (email, role, org_id, invited_by)
  VALUES (invitee_email, invitee_role, target_org_id, auth.uid())
  RETURNING id INTO new_invite_id;

  -- Audit event — actor_id only, NO actor_email (GDPR Art. 5(1)(c))
  -- Note: invitee_email in details is a known GDPR concern carried from 0061.
  -- Future migration should replace with invitation ID only.
  INSERT INTO audit_events (
    event_type, event_category, actor_id, org_id, target_type, target_id, details
  ) VALUES (
    'MEMBER_INVITED', 'ORGANIZATION', auth.uid(), caller_profile.org_id,
    'invitation', new_invite_id::text,
    format('Invited %s as %s', invitee_email, invitee_role)
  );

  RETURN new_invite_id;
END;
$$;


ALTER FUNCTION "public"."invite_member"("invitee_email" "text", "invitee_role" "public"."user_role", "target_org_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."invite_member"("invitee_email" "text", "invitee_role" "public"."user_role", "target_org_id" "uuid") IS 'Invite a member to an organization. ORG_ADMIN role blocked (0160). SET search_path = public only (0161).';



CREATE OR REPLACE FUNCTION "public"."invite_member"("inviter_user_id" "uuid", "invitee_email" "text", "invitee_role" "text", "target_org_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inviter_role text;
  v_invitation_id uuid;
BEGIN
  SELECT role INTO v_inviter_role
  FROM profiles
  WHERE user_id = inviter_user_id AND org_id = target_org_id;
  IF v_inviter_role IS NULL OR v_inviter_role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization admins can invite members';
  END IF;
  INSERT INTO invitations (org_id, invited_by, email, role, status)
  VALUES (target_org_id, inviter_user_id, invitee_email, invitee_role, 'PENDING')
  RETURNING id INTO v_invitation_id;
  INSERT INTO audit_events (actor_id, org_id, action, details)
  VALUES (
    inviter_user_id,
    target_org_id,
    'invite_member',
    format('Invitation %s created for role %s', v_invitation_id, invitee_role)
  );
  RETURN v_invitation_id;
END;
$$;


ALTER FUNCTION "public"."invite_member"("inviter_user_id" "uuid", "invitee_email" "text", "invitee_role" "text", "target_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_current_user_platform_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT is_platform_admin FROM profiles WHERE id = auth.uid()),
    false
  );
$$;


ALTER FUNCTION "public"."is_current_user_platform_admin"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_current_user_platform_admin"() IS 'SECURITY DEFINER: checks if current user is platform admin. Cached per statement via STABLE.';



CREATE OR REPLACE FUNCTION "public"."is_org_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'ORG_ADMIN'
  );
$$;


ALTER FUNCTION "public"."is_org_admin"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_org_admin"() IS 'Returns true if current user has ORG_ADMIN role';



CREATE OR REPLACE FUNCTION "public"."is_org_admin_of"("target_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = auth.uid()
    AND org_id = target_org_id
    AND role IN ('owner', 'admin')
  );
$$;


ALTER FUNCTION "public"."is_org_admin_of"("target_org_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_org_admin_of"("target_org_id" "uuid") IS 'Returns true if current user is admin/owner of the specified org';



CREATE OR REPLACE FUNCTION "public"."is_org_suspended"("p_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT coalesce(
    (SELECT suspended FROM organizations WHERE id = p_org_id),
    false
  );
$$;


ALTER FUNCTION "public"."is_org_suspended"("p_org_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_org_suspended"("p_org_id" "uuid") IS 'SCRUM-1652: returns true if the given org_id is currently suspended. Worker-side guards call this before dispatching anchor / queue / integration-trigger actions.';



CREATE OR REPLACE FUNCTION "public"."is_user_verified"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT identity_verification_status = 'verified'
     FROM profiles
     WHERE id = p_user_id),
    false
  );
$$;


ALTER FUNCTION "public"."is_user_verified"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_user_verified"("p_user_id" "uuid") IS 'Check if a user has completed KYC verification (IDT WS1)';



CREATE OR REPLACE FUNCTION "public"."join_org_by_domain"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_user_email text;
  v_user_domain text;
  v_org_domain text;
  v_current_role user_role;
  v_current_org_id uuid;
  v_membership_count integer;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT email INTO v_user_email
  FROM auth.users
  WHERE id = v_user_id;

  v_user_domain := lower(split_part(v_user_email, '@', 2));

  SELECT lower(domain) INTO v_org_domain
  FROM organizations
  WHERE id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_org_domain IS NULL OR v_org_domain != v_user_domain THEN
    RAISE EXCEPTION 'Email domain does not match organization domain'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  INSERT INTO org_members (user_id, org_id, role)
  VALUES (v_user_id, p_org_id, 'member')
  ON CONFLICT (user_id, org_id) DO NOTHING;
  GET DIAGNOSTICS v_membership_count = ROW_COUNT;

  SELECT role, org_id
  INTO v_current_role, v_current_org_id
  FROM profiles
  WHERE id = v_user_id;

  IF v_current_role IS NULL THEN
    UPDATE profiles
    SET role = 'ORG_MEMBER', org_id = p_org_id
    WHERE id = v_user_id;

    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES (
      'profile.role_set',
      'PROFILE',
      v_user_id,
      'profile',
      v_user_id,
      p_org_id,
      format('Auto-joined org by domain match (%s)', v_user_domain)
    );

    RETURN jsonb_build_object(
      'success', true,
      'already_set', false,
      'role', 'ORG_MEMBER',
      'user_id', v_user_id,
      'org_id', p_org_id
    );
  END IF;

  IF v_current_org_id IS NULL THEN
    UPDATE profiles
    SET org_id = p_org_id
    WHERE id = v_user_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_set', v_membership_count = 0,
    'role', v_current_role::text,
    'user_id', v_user_id,
    'org_id', COALESCE(v_current_org_id, p_org_id)
  );
END;
$$;


ALTER FUNCTION "public"."join_org_by_domain"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."link_public_records_to_anchors"("p_items" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE
  v_records_updated bigint := 0;
BEGIN
  WITH input_data AS (
    SELECT
      (elem->>'record_id')::uuid AS record_id,
      (elem->>'anchor_id')::uuid AS anchor_id
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS elem
  ),
  updated_records AS (
    UPDATE public.public_records pr
    SET
      anchor_id = i.anchor_id,
      updated_at = now(),
      metadata = COALESCE(pr.metadata, '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object(
          'merkle_proof', COALESCE(ap.proof_path, a.metadata->'merkle_proof', '[]'::jsonb),
          'merkle_root', COALESCE(ap.merkle_root, a.metadata->>'merkle_root'),
          'batch_id', COALESCE(ap.batch_id, a.metadata->>'batch_id'),
          'chain_tx_id', a.chain_tx_id
        ))
    FROM input_data i
    JOIN public.anchors a ON a.id = i.anchor_id
    LEFT JOIN public.anchor_proofs ap ON ap.anchor_id = a.id
    WHERE pr.id = i.record_id
      AND (pr.anchor_id IS NULL OR pr.anchor_id = i.anchor_id)
      AND a.deleted_at IS NULL
      AND a.status IN ('SUBMITTED', 'SECURED')
      AND a.chain_tx_id IS NOT NULL
    RETURNING pr.id
  )
  SELECT count(*) INTO v_records_updated FROM updated_records;

  RETURN jsonb_build_object('records_updated', COALESCE(v_records_updated, 0));
END;
$$;


ALTER FUNCTION "public"."link_public_records_to_anchors"("p_items" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."link_public_records_to_anchors"("p_items" "jsonb") IS 'Links public_records to already-bitcoin-anchored anchors, preferring anchor_proofs over legacy metadata.';



CREATE OR REPLACE FUNCTION "public"."link_recipient_on_signup"("p_user_id" "uuid", "p_email_hash" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ DECLARE linked_count integer; BEGIN UPDATE anchor_recipients SET recipient_user_id = p_user_id, claimed_at = now() WHERE recipient_email_hash = p_email_hash AND recipient_user_id IS NULL; GET DIAGNOSTICS linked_count = ROW_COUNT; RETURN linked_count; END; $$;


ALTER FUNCTION "public"."link_recipient_on_signup"("p_user_id" "uuid", "p_email_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_pending_resolution_anchors"("p_limit" integer DEFAULT 100) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  caller_profile RECORD;
  v_result jsonb;
BEGIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.org_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Clamp limit defensively so pathological callers can't DOS the table.
  p_limit := LEAST(GREATEST(p_limit, 1), 500);

  -- Window function computes sibling_count over the PENDING_RESOLUTION set
  -- in a single scan — replaces the per-row correlated subquery that would
  -- N+1 at scale.
  WITH pending AS (
    SELECT
      id, metadata, filename, fingerprint, created_at,
      COUNT(*) OVER (PARTITION BY metadata->>'external_file_id') - 1 AS sibling_count
    FROM anchors
    WHERE org_id = caller_profile.org_id
      AND status = 'PENDING_RESOLUTION'
      AND deleted_at IS NULL
  ),
  paged AS (
    SELECT * FROM pending
    ORDER BY created_at DESC
    LIMIT p_limit
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'external_file_id', metadata->>'external_file_id',
      'filename', filename,
      'fingerprint', fingerprint,
      'created_at', created_at,
      'sibling_count', sibling_count::INTEGER
    )
    ORDER BY created_at DESC
  ) INTO v_result
  FROM paged;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;


ALTER FUNCTION "public"."list_pending_resolution_anchors"("p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."list_pending_resolution_anchors"("p_limit" integer) IS 'ARK-101: return anchors in PENDING_RESOLUTION state for the caller''s org, with sibling counts for collision visualization.';



CREATE OR REPLACE FUNCTION "public"."list_pending_resolution_anchors_v2"("p_limit" integer DEFAULT 100) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  caller_profile RECORD;
  v_result jsonb;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;
  IF caller_profile.org_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  p_limit := LEAST(GREATEST(p_limit, 1), 500);
  WITH pending AS (
    SELECT public_id, metadata, filename, fingerprint, created_at,
      COUNT(*) OVER (PARTITION BY metadata->>'external_file_id') - 1 AS sibling_count
    FROM anchors
    WHERE org_id = caller_profile.org_id
      AND status = 'PENDING_RESOLUTION'
      AND deleted_at IS NULL
      AND public_id IS NOT NULL
  ),
  paged AS (
    SELECT * FROM pending ORDER BY created_at DESC LIMIT p_limit
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'public_id', public_id,
      'external_file_id', metadata->>'external_file_id',
      'filename', filename,
      'fingerprint', fingerprint,
      'created_at', created_at,
      'sibling_count', sibling_count::INTEGER
    ) ORDER BY created_at DESC
  ) INTO v_result FROM paged;
  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;


ALTER FUNCTION "public"."list_pending_resolution_anchors_v2"("p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."list_pending_resolution_anchors_v2"("p_limit" integer) IS 'SCRUM-1121: returns PENDING_RESOLUTION anchors keyed by public_id (IDOR defense-in-depth over original list_pending_resolution_anchors).';



CREATE OR REPLACE FUNCTION "public"."log_switchboard_flag_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO switchboard_flag_history (flag_key, old_value, new_value, changed_by)
  VALUES (NEW.flag_key, OLD.enabled, NEW.enabled, auth.uid());
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."log_switchboard_flag_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_verification_event"("p_public_id" "text", "p_method" "text" DEFAULT 'web'::"text", "p_result" "text" DEFAULT 'verified'::"text", "p_fingerprint_provided" boolean DEFAULT false, "p_user_agent" "text" DEFAULT NULL::"text", "p_referrer" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_anchor_id uuid;
  v_org_id uuid;
BEGIN
  SELECT a.id, a.org_id
    INTO v_anchor_id, v_org_id
    FROM anchors a
   WHERE a.public_id = p_public_id
   LIMIT 1;

  INSERT INTO verification_events (
    anchor_id, public_id, method, result,
    fingerprint_provided, user_agent, referrer, org_id
  ) VALUES (
    v_anchor_id, p_public_id, p_method, p_result,
    p_fingerprint_provided, p_user_agent, p_referrer, v_org_id
  );
END;
$$;


ALTER FUNCTION "public"."log_verification_event"("p_public_id" "text", "p_method" "text", "p_result" "text", "p_fingerprint_provided" boolean, "p_user_agent" "text", "p_referrer" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."log_verification_event"("p_public_id" "text", "p_method" "text", "p_result" "text", "p_fingerprint_provided" boolean, "p_user_agent" "text", "p_referrer" "text") IS 'Logs a public verification event. SECURITY DEFINER allows unauthenticated callers.';



CREATE OR REPLACE FUNCTION "public"."lookup_org_by_email_domain"("p_email" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_email text;
  v_domain text;
  v_org_id uuid;
  v_org_name text;
  v_org_display_name text;
BEGIN
  -- Security: the caller can only resolve their own email (0075 behavior).
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();

  IF v_caller_email IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF lower(p_email) != lower(v_caller_email) THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_domain := lower(split_part(p_email, '@', 2));

  IF v_domain = '' OR v_domain IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- SCRUM-1161: never auto-match free-mail. See table comment.
  IF EXISTS (SELECT 1 FROM freemail_domains WHERE domain = v_domain) THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT id, legal_name, display_name
  INTO v_org_id, v_org_name, v_org_display_name
  FROM organizations
  WHERE lower(domain) = v_domain
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'org_id', v_org_id,
    'org_name', COALESCE(v_org_display_name, v_org_name),
    'domain', v_domain
  );
END;
$$;


ALTER FUNCTION "public"."lookup_org_by_email_domain"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_attestation_claim_modification"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF OLD.status != 'DRAFT' AND NEW.claims IS DISTINCT FROM OLD.claims THEN
    RAISE EXCEPTION 'Attestation claims cannot be modified after submission'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_attestation_claim_modification"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_credential_type_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$ DECLARE jwt_role text; BEGIN jwt_role := current_setting('request.jwt.claims', true)::json->>'role'; IF jwt_role = 'service_role' THEN RETURN NEW; END IF; IF OLD.status != 'PENDING' AND OLD.credential_type IS DISTINCT FROM NEW.credential_type THEN RAISE EXCEPTION 'credential_type cannot be changed after anchor status leaves PENDING (current: %)', OLD.status; END IF; RETURN NEW; END; $$;


ALTER FUNCTION "public"."prevent_credential_type_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_direct_kyc_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF OLD.identity_verification_status IS DISTINCT FROM NEW.identity_verification_status
    OR OLD.identity_verification_session_id IS DISTINCT FROM NEW.identity_verification_session_id
    OR OLD.identity_verified_at IS DISTINCT FROM NEW.identity_verified_at
    OR OLD.phone_verified_at IS DISTINCT FROM NEW.phone_verified_at
    OR OLD.kyc_provider IS DISTINCT FROM NEW.kyc_provider
  THEN
    RAISE EXCEPTION 'Identity verification fields can only be updated by the system';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_direct_kyc_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_metadata_edit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- No change to metadata or description — allow
  IF (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
     AND (OLD.description IS NOT DISTINCT FROM NEW.description) THEN
    RETURN NEW;
  END IF;

  -- Allow metadata changes on PENDING anchors
  IF OLD.status = 'PENDING' THEN
    RETURN NEW;
  END IF;

  -- Allow metadata changes when recovering (BROADCASTING → PENDING)
  IF OLD.status = 'BROADCASTING' AND NEW.status = 'PENDING' THEN
    RETURN NEW;
  END IF;

  -- Allow metadata changes when transitioning status via service_role
  -- (e.g., BROADCASTING → SUBMITTED, SUBMITTED → SECURED)
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  -- Block metadata/description changes on non-PENDING anchors with no status change
  IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
    RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured, revoked, or expired. Current status: %', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'Cannot modify description after anchor has been secured, revoked, or expired. Current status: %', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_metadata_edit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_metadata_edit_after_secured"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Allow service_role to modify metadata (worker batch processing)
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Allow if neither metadata nor description changed
  IF (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
     AND (OLD.description IS NOT DISTINCT FROM NEW.description)
  THEN
    RETURN NEW;
  END IF;

  -- Block changes when status is not PENDING
  IF OLD.status != 'PENDING' THEN
    -- Allow setting description for the first time (NULL -> value) for backfill
    IF OLD.description IS NULL AND NEW.description IS NOT NULL
       AND (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
    THEN
      RETURN NEW;
    END IF;

    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
      RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.description IS DISTINCT FROM NEW.description THEN
      RAISE EXCEPTION 'Cannot modify description after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_metadata_edit_after_secured"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."prevent_metadata_edit_after_secured"() IS 'Prevents metadata/description edits on non-PENDING anchors for regular users. Service role (pipeline) is exempt.';



CREATE OR REPLACE FUNCTION "public"."protect_anchor_status_transition"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  caller_role text;
BEGIN
  caller_role := get_caller_role();
  IF caller_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status != 'PENDING' THEN
      RAISE EXCEPTION 'New anchors must start in PENDING status'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Cannot change anchor owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
    RAISE EXCEPTION 'Cannot set status to SECURED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status != 'SUBMITTED' AND NEW.status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'Cannot set status to SUBMITTED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status != 'BROADCASTING' AND NEW.status = 'BROADCASTING' THEN
    RAISE EXCEPTION 'Cannot set status to BROADCASTING directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Only the system can change anchor status (current: %, requested: %)',
      OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
     OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
     OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp
     OR OLD.chain_confirmations IS DISTINCT FROM NEW.chain_confirmations THEN
    RAISE EXCEPTION 'Cannot modify chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.revocation_tx_id IS DISTINCT FROM NEW.revocation_tx_id
     OR OLD.revocation_block_height IS DISTINCT FROM NEW.revocation_block_height THEN
    RAISE EXCEPTION 'Cannot modify revocation chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
    RAISE EXCEPTION 'Cannot modify legal_hold directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.parent_anchor_id IS DISTINCT FROM NEW.parent_anchor_id THEN
    RAISE EXCEPTION 'Cannot modify parent_anchor_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.version_number IS DISTINCT FROM NEW.version_number THEN
    RAISE EXCEPTION 'Cannot modify version_number directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (OLD.status IN ('SECURED', 'SUBMITTED', 'BROADCASTING', 'REVOKED'))
     AND OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'Cannot modify description after anchor is secured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_anchor_status_transition"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_platform_admin_flag"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin THEN
    IF current_setting('role') != 'service_role' THEN
      NEW.is_platform_admin := OLD.is_platform_admin;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_platform_admin_flag"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_privileged_profile_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'Cannot modify org_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.requires_manual_review IS DISTINCT FROM NEW.requires_manual_review THEN
    RAISE EXCEPTION 'Cannot modify requires_manual_review directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_reason IS DISTINCT FROM NEW.manual_review_reason THEN
    RAISE EXCEPTION 'Cannot modify manual_review_reason directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_completed_at IS DISTINCT FROM NEW.manual_review_completed_at THEN
    RAISE EXCEPTION 'Cannot modify manual_review_completed_at directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.manual_review_completed_by IS DISTINCT FROM NEW.manual_review_completed_by THEN
    RAISE EXCEPTION 'Cannot modify manual_review_completed_by directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.public_id IS DISTINCT FROM NEW.public_id THEN
    RAISE EXCEPTION 'Cannot modify public_id directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.is_verified IS DISTINCT FROM NEW.is_verified THEN
    RAISE EXCEPTION 'Cannot modify is_verified directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier THEN
    RAISE EXCEPTION 'Cannot modify subscription_tier directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_privileged_profile_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recover_stuck_broadcasts"("p_stale_minutes" integer DEFAULT 5) RETURNS TABLE("anchor_id" "uuid", "anchor_fingerprint" "text", "claimed_by" "text", "stuck_since" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
BEGIN
  RETURN QUERY
  WITH stuck AS (
    UPDATE anchors a
    SET
      status = 'PENDING',
      updated_at = now(),
      metadata = COALESCE(a.metadata, '{}'::jsonb)
        || jsonb_build_object(
          '_recovery_reason', 'stuck_broadcasting',
          '_recovered_at', now()::text,
          '_previous_claimed_by', COALESCE(a.metadata->>'_claimed_by', 'unknown')
        )
        - '_claimed_by'
        - '_claimed_at'
    WHERE a.id IN (
      SELECT a2.id
      FROM anchors a2
      WHERE a2.status = 'BROADCASTING'
        AND a2.updated_at < now() - (p_stale_minutes || ' minutes')::interval
        AND a2.deleted_at IS NULL
        AND a2.chain_tx_id IS NULL
      FOR UPDATE SKIP LOCKED
    )
    RETURNING a.id, a.fingerprint::text, a.metadata->>'_previous_claimed_by' AS claimed_by, a.updated_at
  )
  SELECT stuck.id, stuck.fingerprint, stuck.claimed_by, stuck.updated_at
  FROM stuck;
END;
$$;


ALTER FUNCTION "public"."recover_stuck_broadcasts"("p_stale_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_status_counts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE
  v_total bigint; v_pending bigint; v_submitted bigint;
  v_broadcasting bigint; v_revoked bigint; v_secured bigint;
BEGIN
  SELECT reltuples::bigint INTO v_total FROM pg_class WHERE relname = 'anchors';
  SELECT count(*) INTO v_pending FROM anchors WHERE status = 'PENDING' AND deleted_at IS NULL;
  SELECT count(*) INTO v_submitted FROM anchors WHERE status = 'SUBMITTED' AND deleted_at IS NULL;
  SELECT count(*) INTO v_broadcasting FROM anchors WHERE status = 'BROADCASTING' AND deleted_at IS NULL;
  SELECT count(*) INTO v_revoked FROM anchors WHERE status = 'REVOKED' AND deleted_at IS NULL;
  v_secured := GREATEST(v_total - v_pending - v_submitted - v_broadcasting - v_revoked, 0);

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_status_counts', jsonb_build_object(
    'PENDING', v_pending, 'SUBMITTED', v_submitted,
    'BROADCASTING', v_broadcasting, 'SECURED', v_secured,
    'REVOKED', v_revoked, 'total', v_total
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;


ALTER FUNCTION "public"."refresh_cache_anchor_status_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_tx_stats"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '5s'
    AS $$
DECLARE
  v_anchor_total bigint;
  v_anchors_with_tx bigint;
  v_null_frac float;
  v_last_anchor_time timestamptz;
BEGIN
  -- Total from pg_class (instant)
  SELECT reltuples::bigint INTO v_anchor_total FROM pg_class WHERE relname = 'anchors';

  -- Anchors with tx from pg_stats (instant)
  SELECT COALESCE(null_frac, 0) INTO v_null_frac
  FROM pg_stats WHERE tablename = 'anchors' AND attname = 'chain_tx_id';
  v_anchors_with_tx := COALESCE((v_anchor_total * (1 - v_null_frac))::bigint, 0);

  -- Last anchor time: Index Only Scan on idx_anchors_active_created (cost 0.43-0.46)
  SELECT created_at INTO v_last_anchor_time
  FROM anchors
  WHERE deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  -- Skip last_tx_time — no index on updated_at; use last_anchor_time as proxy.

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_tx_stats', jsonb_build_object(
    'distinct_tx_count', 0,
    'distinct_tx_approximate', true,
    'anchors_with_tx', v_anchors_with_tx,
    'total_anchors', v_anchor_total,
    'last_anchor_time', v_last_anchor_time,
    'last_tx_time', v_last_anchor_time
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;


ALTER FUNCTION "public"."refresh_cache_anchor_tx_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_cache_anchor_type_counts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE v_result jsonb;
BEGIN
  SELECT jsonb_agg(row_to_json(t)::jsonb) INTO v_result
  FROM (
    SELECT COALESCE(credential_type::text, 'UNKNOWN') AS credential_type,
           status::text AS status, count(*)::bigint AS count
    FROM anchors WHERE deleted_at IS NULL
    GROUP BY credential_type, status ORDER BY count(*) DESC
  ) t;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('anchor_type_counts', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;


ALTER FUNCTION "public"."refresh_cache_anchor_type_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_cache_by_source"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE v_by_source jsonb;
BEGIN
  SELECT jsonb_object_agg(source, cnt) INTO v_by_source
  FROM (SELECT source, count(*) AS cnt FROM public_records GROUP BY source) t;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('by_source', COALESCE(v_by_source, '{}'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;


ALTER FUNCTION "public"."refresh_cache_by_source"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_cache_pipeline_stats"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_total bigint := 0;
  v_unlinked bigint := -1;
  v_linked bigint := 0;
  v_embedded bigint := -1;
  v_pending_anchor bigint := -1;
  v_broadcasting bigint := -1;
  v_submitted bigint := -1;
  v_secured bigint := -1;
  v_bitcoin_anchored bigint := 0;
  v_pending_bitcoin bigint := 0;
BEGIN
  SELECT GREATEST(reltuples::bigint, 0) INTO v_total
  FROM pg_class
  WHERE relname = 'public_records' AND relnamespace = 'public'::regnamespace;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_unlinked
    FROM public_records
    WHERE anchor_id IS NULL;
  EXCEPTION
    WHEN query_canceled THEN v_unlinked := -1;
    WHEN OTHERS THEN v_unlinked := -1;
  END;

  IF v_unlinked >= 0 THEN
    v_linked := GREATEST(COALESCE(v_total, 0) - v_unlinked, 0);
  ELSE
    v_linked := -1;
  END IF;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_embedded
    FROM public_record_embeddings;
  EXCEPTION
    WHEN query_canceled THEN v_embedded := -1;
    WHEN OTHERS THEN v_embedded := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_pending_anchor
    FROM anchors
    WHERE status = 'PENDING'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_pending_anchor := -1;
    WHEN OTHERS THEN v_pending_anchor := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_broadcasting
    FROM anchors
    WHERE status = 'BROADCASTING'
      AND deleted_at IS NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_broadcasting := -1;
    WHEN OTHERS THEN v_broadcasting := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_submitted
    FROM anchors
    WHERE status = 'SUBMITTED'
      AND deleted_at IS NULL
      AND chain_tx_id IS NOT NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_submitted := -1;
    WHEN OTHERS THEN v_submitted := -1;
  END;

  BEGIN
    SET LOCAL statement_timeout = '1s';
    SELECT count(*) INTO v_secured
    FROM anchors
    WHERE status = 'SECURED'
      AND deleted_at IS NULL
      AND chain_tx_id IS NOT NULL
      AND metadata ? 'pipeline_source';
  EXCEPTION
    WHEN query_canceled THEN v_secured := -1;
    WHEN OTHERS THEN v_secured := -1;
  END;

  v_bitcoin_anchored := GREATEST(v_submitted, 0) + GREATEST(v_secured, 0);
  v_pending_bitcoin := GREATEST(v_unlinked, 0)
    + GREATEST(v_pending_anchor, 0)
    + GREATEST(v_broadcasting, 0);

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('pipeline_stats', jsonb_build_object(
    'total_records', COALESCE(v_total, 0),
    'anchor_linked_records', v_linked,
    'pending_record_links', v_unlinked,
    'bitcoin_anchored_records', v_bitcoin_anchored,
    'pending_bitcoin_records', v_pending_bitcoin,
    'pending_anchor_records', v_pending_anchor,
    'broadcasting_records', v_broadcasting,
    'submitted_records', v_submitted,
    'secured_records', v_secured,
    'embedded_records', v_embedded
  ), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;


ALTER FUNCTION "public"."refresh_cache_pipeline_stats"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."refresh_cache_pipeline_stats"() IS 'SCRUM-1256 (R1-2) rewrite: per-status counts with 1s budget each + sentinel -1 on query_canceled + WHEN OTHERS. Replaces single-aggregate FILTER pattern that caused the 2026-04-18..25 death spiral when anchors bloat hit 70%. WHEN query_canceled is mandatory — WHEN OTHERS does not catch QUERY_CANCELED (SQLSTATE 57014).';



CREATE OR REPLACE FUNCTION "public"."refresh_cache_record_types"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE v_result jsonb;
BEGIN
  SELECT jsonb_agg(record_type ORDER BY record_type) INTO v_result
  FROM (SELECT DISTINCT record_type FROM public_records) t;

  INSERT INTO pipeline_dashboard_cache (cache_key, cache_value, updated_at)
  VALUES ('record_types', COALESCE(v_result, '[]'::jsonb), now())
  ON CONFLICT (cache_key) DO UPDATE
    SET cache_value = EXCLUDED.cache_value, updated_at = EXCLUDED.updated_at;
END;
$$;


ALTER FUNCTION "public"."refresh_cache_record_types"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_pipeline_dashboard_cache"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '90s'
    AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_errors jsonb := '[]'::jsonb;
  v_succeeded int := 0;
  v_got_lock boolean;
BEGIN
  SELECT pg_try_advisory_lock(8675309, 1) INTO v_got_lock;
  IF NOT v_got_lock THEN
    RETURN jsonb_build_object(
      'status', 'skipped',
      'reason', 'another refresh in progress',
      'duration_ms', extract(milliseconds from clock_timestamp() - v_started_at)::int
    );
  END IF;

  BEGIN
    BEGIN PERFORM refresh_cache_pipeline_stats(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('pipeline_stats', SQLERRM); END;

    BEGIN PERFORM refresh_cache_anchor_status_counts(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_status_counts', SQLERRM); END;

    BEGIN PERFORM refresh_cache_by_source(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('by_source', SQLERRM); END;

    BEGIN PERFORM refresh_cache_anchor_type_counts(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_type_counts', SQLERRM); END;

    BEGIN PERFORM refresh_cache_record_types(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('record_types', SQLERRM); END;

    BEGIN PERFORM refresh_cache_anchor_tx_stats(); v_succeeded := v_succeeded + 1;
    EXCEPTION WHEN OTHERS THEN v_errors := v_errors || jsonb_build_object('anchor_tx_stats', SQLERRM); END;

    PERFORM pg_advisory_unlock(8675309, 1);

    RETURN jsonb_build_object(
      'status', 'refreshed',
      'succeeded', v_succeeded,
      'errors', v_errors,
      'duration_ms', extract(milliseconds from clock_timestamp() - v_started_at)::int
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(8675309, 1);
    RAISE;
  END;
END;
$$;


ALTER FUNCTION "public"."refresh_pipeline_dashboard_cache"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_stats_cache"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '30s'
    AS $$
BEGIN
  INSERT INTO stats_cache (key, value) VALUES
    ('anchor_stats', jsonb_build_object(
      'total_anchors', (SELECT COUNT(*) FROM anchors WHERE deleted_at IS NULL),
      'anchors_with_tx', (SELECT COUNT(*) FROM anchors WHERE deleted_at IS NULL AND chain_tx_id IS NOT NULL),
      'total_distinct_txs', (SELECT COUNT(DISTINCT chain_tx_id) FROM anchors WHERE deleted_at IS NULL AND chain_tx_id IS NOT NULL),
      'latest_tx_timestamp', (SELECT MAX(chain_timestamp) FROM anchors WHERE deleted_at IS NULL),
      'secured_count', (SELECT COUNT(*) FROM anchors WHERE deleted_at IS NULL AND status = 'SECURED'),
      'submitted_count', (SELECT COUNT(*) FROM anchors WHERE deleted_at IS NULL AND status = 'SUBMITTED'),
      'pending_count', (SELECT COUNT(*) FROM anchors WHERE deleted_at IS NULL AND status = 'PENDING')
    )),
    ('pipeline_stats', jsonb_build_object(
      'total_records', (SELECT COUNT(*) FROM public_records),
      'anchored_records', (SELECT COUNT(*) FROM public_records WHERE anchor_id IS NOT NULL),
      'pending_records', (SELECT COUNT(*) FROM public_records WHERE anchor_id IS NULL),
      'embedded_records', (SELECT COUNT(*) FROM public_record_embeddings)
    )),
    ('treasury_stats', jsonb_build_object(
      'total_payments', (SELECT COUNT(*) FROM x402_payments),
      'total_revenue_usd', COALESCE((SELECT SUM(amount_usd) FROM x402_payments), 0),
      'total_anchors', (SELECT COUNT(*) FROM anchors WHERE deleted_at IS NULL)
    ))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END;
$$;


ALTER FUNCTION "public"."refresh_stats_cache"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_stats_materialized_views"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_anchor_status_counts;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_public_records_source_counts;
END;
$$;


ALTER FUNCTION "public"."refresh_stats_materialized_views"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_audit_modification"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are immutable. % operations are not allowed.', TG_OP
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."reject_audit_modification"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_advisory_lock"("lock_id" bigint) RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT pg_advisory_unlock(lock_id);
$$;


ALTER FUNCTION "public"."release_advisory_lock"("lock_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_claimed_rule_events"("p_event_ids" "uuid"[], "p_error" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE organization_rule_events q
  SET status = CASE
        WHEN q.attempt_count >= 5 THEN 'FAILED'::org_rule_event_status
        ELSE 'PENDING'::org_rule_event_status
      END,
      claim_id = NULL,
      claimed_at = NULL,
      error = LEFT(COALESCE(p_error, 'Released after rules-engine failure'), 4000)
  WHERE q.id = ANY(COALESCE(p_event_ids, ARRAY[]::UUID[]))
    AND q.status = 'CLAIMED';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."release_claimed_rule_events"("p_event_ids" "uuid"[], "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_anchor_queue"("p_external_file_id" "text", "p_selected_anchor_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  caller_profile RECORD;
  v_selected_anchor anchors%ROWTYPE;
  v_selected_ext_id TEXT;
  v_org_id UUID;
  v_sibling_ids UUID[];
  v_resolution_id UUID;
  v_existing_id UUID;
BEGIN
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can resolve queued anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_selected_anchor
  FROM anchors
  WHERE id = p_selected_anchor_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_selected_anchor.org_id;

  IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot resolve anchor from different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
    RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Cross-check that the selected anchor actually belongs to the
  -- external_file_id collision set the caller is resolving. Without this,
  -- a caller could pick an anchor from set A while claiming to resolve
  -- set B, causing the revoke loop below to erroneously revoke B's siblings.
  v_selected_ext_id := v_selected_anchor.metadata->>'external_file_id';
  IF v_selected_ext_id IS DISTINCT FROM p_external_file_id THEN
    RAISE EXCEPTION 'Selected anchor external_file_id (%) does not match requested collision set (%)',
      COALESCE(v_selected_ext_id, '<null>'), p_external_file_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotency short-circuit (same resolution requested again).
  SELECT id INTO v_existing_id
  FROM anchor_queue_resolutions
  WHERE org_id = v_org_id
    AND external_file_id = p_external_file_id
    AND selected_anchor_id = p_selected_anchor_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Lock the collision set.
  PERFORM 1
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND deleted_at IS NULL
  FOR UPDATE;

  -- Siblings.
  SELECT ARRAY_AGG(id) INTO v_sibling_ids
  FROM anchors
  WHERE org_id = v_org_id
    AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id
    AND id != p_selected_anchor_id
    AND deleted_at IS NULL;

  v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);

  UPDATE anchors
  SET status = 'PENDING'::anchor_status,
      updated_at = now()
  WHERE id = p_selected_anchor_id;

  IF cardinality(v_sibling_ids) > 0 THEN
    UPDATE anchors
    SET status = 'REVOKED'::anchor_status,
        revoked_at = now(),
        revocation_reason = 'Rejected in queue resolution: superseded by ' || p_selected_anchor_id::text,
        updated_at = now()
    WHERE id = ANY(v_sibling_ids);
  END IF;

  INSERT INTO anchor_queue_resolutions (
    org_id, external_file_id, selected_anchor_id,
    rejected_anchor_ids, reason, resolved_by_user_id
  ) VALUES (
    v_org_id, p_external_file_id, p_selected_anchor_id,
    v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
  )
  RETURNING id INTO v_resolution_id;

  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR',
    auth.uid(), caller_profile.email, v_org_id,
    'anchor', p_selected_anchor_id::text,
    jsonb_build_object(
      'external_file_id', p_external_file_id,
      'rejected_anchor_ids', to_jsonb(v_sibling_ids),
      'reason', LEFT(p_reason, 2000),
      'resolution_id', v_resolution_id
    )::text
  );

  RETURN v_resolution_id;
END;
$$;


ALTER FUNCTION "public"."resolve_anchor_queue"("p_external_file_id" "text", "p_selected_anchor_id" "uuid", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."resolve_anchor_queue"("p_external_file_id" "text", "p_selected_anchor_id" "uuid", "p_reason" "text") IS 'ARK-101 (migration 0234 replaces 0228 body): resolve a PENDING_RESOLUTION collision set. Cross-checks that p_selected_anchor_id actually belongs to the p_external_file_id set before revoking siblings.';



CREATE OR REPLACE FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  caller_profile RECORD;
  v_org_id UUID;
  v_selected_anchor anchors%ROWTYPE;
  v_sibling_ids UUID[];
  v_sibling_public_ids TEXT[];
  v_resolution_id UUID;
  v_existing_id UUID;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001';
  END IF;
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can resolve queued anchors' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_selected_anchor FROM anchors WHERE public_id = p_selected_public_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected anchor not found' USING ERRCODE = 'P0001';
  END IF;
  v_org_id := v_selected_anchor.org_id;
  IF v_org_id IS NULL OR v_org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot resolve anchor from different organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_selected_anchor.status != 'PENDING_RESOLUTION' THEN
    RAISE EXCEPTION 'Anchor is not awaiting resolution (status: %)', v_selected_anchor.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_existing_id
  FROM anchor_queue_resolutions
  WHERE org_id = v_org_id AND external_file_id = p_external_file_id AND selected_anchor_id = v_selected_anchor.id;
  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;
  PERFORM 1 FROM anchors
  WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id AND deleted_at IS NULL
  FOR UPDATE;
  SELECT ARRAY_AGG(id), ARRAY_AGG(public_id) FILTER (WHERE public_id IS NOT NULL)
  INTO v_sibling_ids, v_sibling_public_ids
  FROM anchors
  WHERE org_id = v_org_id AND status = 'PENDING_RESOLUTION'
    AND metadata->>'external_file_id' = p_external_file_id AND id != v_selected_anchor.id AND deleted_at IS NULL;
  v_sibling_ids := COALESCE(v_sibling_ids, ARRAY[]::UUID[]);
  v_sibling_public_ids := COALESCE(v_sibling_public_ids, ARRAY[]::TEXT[]);
  UPDATE anchors SET status = 'PENDING'::anchor_status, updated_at = now() WHERE id = v_selected_anchor.id;
  IF cardinality(v_sibling_ids) > 0 THEN
    UPDATE anchors
    SET status = 'REVOKED'::anchor_status, revoked_at = now(),
        revocation_reason = 'Rejected in queue resolution: superseded by ' || v_selected_anchor.public_id,
        updated_at = now()
    WHERE id = ANY(v_sibling_ids);
  END IF;
  INSERT INTO anchor_queue_resolutions (
    org_id, external_file_id, selected_anchor_id, rejected_anchor_ids, reason, resolved_by_user_id
  ) VALUES (
    v_org_id, p_external_file_id, v_selected_anchor.id, v_sibling_ids, LEFT(p_reason, 2000), auth.uid()
  ) RETURNING id INTO v_resolution_id;
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id, target_type, target_id, details
  ) VALUES (
    'ANCHOR_QUEUE_RESOLVED', 'ANCHOR', auth.uid(), caller_profile.email, v_org_id,
    'anchor', v_selected_anchor.public_id,
    jsonb_build_object(
      'external_file_id', p_external_file_id,
      'selected_public_id', v_selected_anchor.public_id,
      'rejected_public_ids', v_sibling_public_ids,
      'reason', LEFT(p_reason, 2000)
    )::text
  );
  RETURN v_resolution_id;
END;
$$;


ALTER FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text") IS 'SCRUM-1121: same logic as resolve_anchor_queue but accepts public_id (IDOR defense-in-depth).';



CREATE OR REPLACE FUNCTION "public"."revoke_anchor"("anchor_id" "uuid", "reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  anchor_record RECORD;
  caller_profile RECORD;
  truncated_reason text;
BEGIN
  SELECT * INTO caller_profile FROM profiles WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0001'; END IF;
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can revoke anchors' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO anchor_record FROM anchors WHERE id = anchor_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Anchor not found' USING ERRCODE = 'P0001'; END IF;
  IF anchor_record.org_id IS NULL OR anchor_record.org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot revoke anchor from different organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF anchor_record.status = 'REVOKED' THEN RAISE EXCEPTION 'Anchor is already revoked' USING ERRCODE = 'check_violation'; END IF;
  IF anchor_record.legal_hold = true THEN RAISE EXCEPTION 'Cannot revoke anchor under legal hold' USING ERRCODE = 'check_violation'; END IF;

  truncated_reason := left(reason, 2000);

  UPDATE anchors SET status = 'REVOKED', revoked_at = now(), revocation_reason = truncated_reason, updated_at = now() WHERE id = anchor_id;

  INSERT INTO audit_events (event_type, event_category, actor_id, org_id, target_type, target_id, details)
  VALUES ('ANCHOR_REVOKED', 'ANCHOR', auth.uid(), caller_profile.org_id, 'anchor', anchor_id::text,
    jsonb_build_object('previous_status', anchor_record.status, 'filename', anchor_record.filename, 'fingerprint', anchor_record.fingerprint, 'reason', truncated_reason)::text);
END;
$$;


ALTER FUNCTION "public"."revoke_anchor"("anchor_id" "uuid", "reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."roll_over_monthly_allocation"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_current record;
  v_next_start date;
  v_next_end date;
  v_carry integer;
  v_cap integer;
  v_new_id uuid;
BEGIN
  -- Find the latest (not-yet-closed) allocation period for this org.
  SELECT * INTO v_current
  FROM org_monthly_allocation
  WHERE org_id = p_org_id
    AND closed_at IS NULL
  ORDER BY period_start DESC
  LIMIT 1;

  IF v_current IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_current_period');
  END IF;

  v_next_start := (v_current.period_end + INTERVAL '1 day')::date;
  v_next_end := (v_next_start + INTERVAL '1 month' - INTERVAL '1 day')::date;

  -- Carry over = (base + rolled) - used, floored at 0.
  v_carry := GREATEST(0, (v_current.base_allocation + v_current.rolled_over_balance) - v_current.used_this_cycle);

  -- Cap at 3x base to prevent unbounded hoarding.
  v_cap := v_current.base_allocation * 3;
  IF v_carry > v_cap THEN v_carry := v_cap; END IF;

  -- Close current period.
  UPDATE org_monthly_allocation
  SET closed_at = now()
  WHERE id = v_current.id
    AND closed_at IS NULL;

  -- Open next period. Use INSERT ... ON CONFLICT to stay idempotent.
  INSERT INTO org_monthly_allocation (
    org_id, period_start, period_end,
    base_allocation, rolled_over_balance,
    anchor_fee_credits, used_this_cycle
  )
  VALUES (
    p_org_id, v_next_start, v_next_end,
    v_current.base_allocation, v_carry,
    v_current.anchor_fee_credits, 0
  )
  ON CONFLICT (org_id, period_start) DO NOTHING
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'ok', true,
    'closed_period_start', v_current.period_start,
    'next_period_id', v_new_id,
    'rolled_over', v_carry
  );
END;
$$;


ALTER FUNCTION "public"."roll_over_monthly_allocation"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sanitize_metadata_for_public"("p_metadata" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    p_metadata
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
      - 'drivers_license',
    '{}'::jsonb
  );
$$;


ALTER FUNCTION "public"."sanitize_metadata_for_public"("p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_credential_embeddings"("p_org_id" "uuid", "p_query_embedding" "public"."vector", "p_match_threshold" double precision DEFAULT 0.7, "p_match_count" integer DEFAULT 10) RETURNS TABLE("anchor_id" "uuid", "similarity" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ce.anchor_id,
    (1 - (ce.embedding <=> p_query_embedding))::float AS similarity
  FROM credential_embeddings ce
  WHERE ce.org_id = p_org_id
    AND (1 - (ce.embedding <=> p_query_embedding)) > p_match_threshold
  ORDER BY ce.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;


ALTER FUNCTION "public"."search_credential_embeddings"("p_org_id" "uuid", "p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_issuer_ground_truth"("p_issuer_name" "text") RETURNS TABLE("id" "uuid", "name" "text", "match_strategy" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_normalized text;
BEGIN
  IF p_issuer_name IS NULL OR length(trim(p_issuer_name)) < 2 THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT igt.id, igt.name, 'exact'::text AS match_strategy
    FROM institution_ground_truth igt
    WHERE igt.name ILIKE p_issuer_name
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;
  v_normalized := regexp_replace(trim(p_issuer_name), '^(The|A)\s+', '', 'i');
  IF length(v_normalized) < 2 THEN RETURN; END IF;
  RETURN QUERY
    SELECT igt.id, igt.name, 'fuzzy'::text AS match_strategy
    FROM institution_ground_truth igt
    WHERE igt.name ILIKE '%' || v_normalized || '%'
    LIMIT 1;
END;
$$;


ALTER FUNCTION "public"."search_issuer_ground_truth"("p_issuer_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_organizations_public"("p_query" "text") RETURNS TABLE("id" "uuid", "display_name" "text", "domain" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_query text;
BEGIN
  -- Sanitize: escape LIKE wildcards
  v_query := '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
    SELECT o.id, o.display_name, o.domain
    FROM organizations o
    WHERE o.display_name ILIKE v_query OR o.domain ILIKE v_query
    LIMIT 5;
END;
$$;


ALTER FUNCTION "public"."search_organizations_public"("p_query" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_organizations_public"("p_query" "text") IS 'Search organizations by name or domain during onboarding. Returns up to 5 matches. SECURITY DEFINER to bypass RLS that restricts org visibility to members.';



CREATE OR REPLACE FUNCTION "public"."search_public_credential_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision DEFAULT 0.75, "p_match_count" integer DEFAULT 5) RETURNS TABLE("public_id" "text", "status" "text", "issuer_name" "text", "credential_type" "text", "issued_date" "text", "expiry_date" "text", "anchor_timestamp" timestamp with time zone, "similarity" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.public_id::text,
    a.status::text,
    o.name::text AS issuer_name,
    a.credential_type::text,
    (a.metadata->>'issuedDate')::text AS issued_date,
    (a.metadata->>'expiryDate')::text AS expiry_date,
    a.created_at AS anchor_timestamp,
    (1 - (ce.embedding <=> p_query_embedding))::float AS similarity
  FROM credential_embeddings ce
  JOIN anchors a ON a.id = ce.anchor_id
  JOIN organizations o ON o.id = a.org_id
  WHERE a.public_id IS NOT NULL
    AND (1 - (ce.embedding <=> p_query_embedding)) > p_match_threshold
  ORDER BY ce.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;


ALTER FUNCTION "public"."search_public_credential_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_credentials"("p_query" "text", "p_limit" integer DEFAULT 10) RETURNS SETOF "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '5s'
    AS $$
DECLARE
  v_limit  integer;
  v_pattern text;
BEGIN
  v_limit  := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

  IF p_query IS NULL OR length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  v_pattern := '%' || trim(p_query) || '%';

  RETURN QUERY
  WITH public_org_ids AS MATERIALIZED (
    SELECT DISTINCT p.org_id
    FROM   profiles p
    WHERE  p.role             = 'ORG_ADMIN'
      AND  p.is_public_profile = true
      AND  p.org_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'public_id',       a.public_id,
    'title',           a.filename,
    'credential_type', a.credential_type,
    'status',          a.status,
    'created_at',      a.created_at,
    'org_id',          a.org_id
  )
  FROM  anchors a
  WHERE a.deleted_at IS NULL
    AND a.status IN ('SECURED', 'SUBMITTED')
    AND (
      a.org_id IS NULL
      OR a.org_id IN (SELECT org_id FROM public_org_ids)
    )
    AND (
      a.filename    ILIKE v_pattern
      OR a.description ILIKE v_pattern
    )
  ORDER BY a.created_at DESC
  LIMIT v_limit;
END;
$$;


ALTER FUNCTION "public"."search_public_credentials"("p_query" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_issuers"("p_query" "text", "p_limit" integer DEFAULT 20, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" "uuid", "legal_name" "text", "display_name" "text", "public_id" "text", "verified" boolean, "credential_count" bigint)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '10s'
    AS $$
DECLARE
  v_safe_query text;
  v_pattern text;
BEGIN
  v_safe_query := replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_');
  v_pattern := '%' || v_safe_query || '%';

  RETURN QUERY
  SELECT
    o.id,
    o.legal_name,
    o.display_name,
    o.public_id,
    o.verification_status = 'APPROVED' AS verified,
    (
      SELECT count(*)
      FROM anchors a
      WHERE a.org_id = o.id
        AND a.status = 'SECURED'
        AND a.deleted_at IS NULL
        AND (a.metadata->>'pipeline_source') IS NULL
    ) AS credential_count
  FROM organizations o
  WHERE EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.org_id = o.id
      AND p.role = 'ORG_ADMIN'
      AND p.is_public_profile = true
  )
  AND (
    o.legal_name ILIKE v_pattern
    OR o.display_name ILIKE v_pattern
  )
  ORDER BY credential_count DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;


ALTER FUNCTION "public"."search_public_issuers"("p_query" "text", "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_public_record_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision DEFAULT 0.65, "p_match_count" integer DEFAULT 10) RETURNS TABLE("public_record_id" "uuid", "similarity" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
    SELECT
      pre.public_record_id,
      (1 - (pre.embedding <=> p_query_embedding))::float AS similarity
    FROM public_record_embeddings pre
    WHERE (1 - (pre.embedding <=> p_query_embedding)) > p_match_threshold
    ORDER BY pre.embedding <=> p_query_embedding
    LIMIT p_match_count;
END;
$$;


ALTER FUNCTION "public"."search_public_record_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_public_record_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) IS 'Cosine similarity search over public record embeddings for Nessie RAG';



CREATE OR REPLACE FUNCTION "public"."set_anchor_version_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.parent_anchor_id IS NULL THEN
    NEW.version_number := 1;
    RETURN NEW;
  END IF;

  SELECT version_number + 1 INTO NEW.version_number
  FROM anchors
  WHERE id = NEW.parent_anchor_id;

  IF NEW.version_number IS NULL THEN
    NEW.version_number := 1;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_anchor_version_number"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_anchor_version_number"() IS 'Auto-computes version_number from parent lineage on anchor insert';



CREATE OR REPLACE FUNCTION "public"."set_onboarding_plan"("p_tier" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_valid_tiers text[] := ARRAY[
    'free',
    'starter',
    'professional',
    'enterprise',
    'individual',
    'organization',
    'verified_individual',
    'org_free',
    'small_business',
    'medium_business'
  ];
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (p_tier = ANY(v_valid_tiers)) THEN
    RAISE EXCEPTION 'Invalid subscription tier: %', p_tier
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  UPDATE profiles
  SET subscription_tier = p_tier
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object('success', true, 'tier', p_tier);
END;
$$;


ALTER FUNCTION "public"."set_onboarding_plan"("p_tier" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_onboarding_plan"("p_tier" "text") IS 'Set subscription tier during onboarding. Validates tier value and runs as SECURITY DEFINER to bypass the protect_privileged_profile_fields trigger.';



CREATE OR REPLACE FUNCTION "public"."set_webhook_delivery_log_public_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.public_id := NULLIF(btrim(NEW.public_id), '');

  IF NEW.public_id IS NULL THEN
    NEW.public_id := 'DLV-' ||
      upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 16));
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_webhook_delivery_log_public_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_webhook_endpoint_public_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org_prefix text;
BEGIN
  NEW.public_id := NULLIF(btrim(NEW.public_id), '');

  IF NEW.public_id IS NULL THEN
    SELECT org_prefix
      INTO v_org_prefix
      FROM organizations
      WHERE id = NEW.org_id;

    NEW.public_id := 'WHK-' || COALESCE(NULLIF(btrim(v_org_prefix), ''), 'IND') || '-' ||
      upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 16));
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_webhook_endpoint_public_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_kyb_verification"("p_org_id" "uuid", "p_provider" "text", "p_reference_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_role text;
BEGIN
  IF p_provider NOT IN ('middesk', 'manual') THEN
    RAISE EXCEPTION 'Invalid KYB provider: %', p_provider
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Must be org admin/owner to kick off KYB.
  SELECT role INTO v_caller_role
  FROM org_members
  WHERE org_id = p_org_id AND user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Not an organization admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  UPDATE organizations
  SET
    kyb_provider = p_provider,
    kyb_reference_id = p_reference_id,
    kyb_submitted_at = now(),
    verification_status = 'PENDING'
  WHERE id = p_org_id;

  INSERT INTO kyb_events (org_id, provider, event_type, status, details)
  VALUES (
    p_org_id,
    p_provider,
    'kyb.submitted',
    'submitted',
    jsonb_build_object('submitted_by', auth.uid())
  );

  RETURN jsonb_build_object(
    'success', true,
    'org_id', p_org_id,
    'provider', p_provider,
    'reference_id', p_reference_id
  );
END;
$$;


ALTER FUNCTION "public"."start_kyb_verification"("p_org_id" "uuid", "p_provider" "text", "p_reference_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_payment_grace"("p_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE organizations
  SET
    payment_state = 'grace',
    payment_grace_expires_at = now() + INTERVAL '3 days',
    payment_state_updated_at = now()
  WHERE id = p_org_id
    AND (payment_state IS NULL OR payment_state = 'ok');
  RETURN jsonb_build_object('ok', true, 'org_id', p_org_id);
END;
$$;


ALTER FUNCTION "public"."start_payment_grace"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_batch_anchors"("p_anchor_ids" "uuid"[], "p_tx_id" "text", "p_block_height" bigint DEFAULT NULL::bigint, "p_block_timestamp" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_merkle_root" "text" DEFAULT NULL::"text", "p_batch_id" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "statement_timeout" TO '60s'
    AS $$
DECLARE
  cnt int;
BEGIN
  UPDATE public.anchors
  SET
    status = 'SUBMITTED',
    chain_tx_id = p_tx_id,
    chain_block_height = p_block_height,
    chain_timestamp = p_block_timestamp,
    updated_at = now()
  WHERE id = ANY(p_anchor_ids)
    AND status IN ('BROADCASTING', 'PENDING');

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;


ALTER FUNCTION "public"."submit_batch_anchors"("p_anchor_ids" "uuid"[], "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."submit_batch_anchors"("p_anchor_ids" "uuid"[], "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") IS 'Bulk-updates anchors to SUBMITTED without rewriting anchors.metadata. SCALE-02 stores batch proof data in anchor_proofs instead.';



CREATE OR REPLACE FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  old_anchor anchors%ROWTYPE;
  caller_profile RECORD;
  new_anchor_id UUID;
  existing_child_id UUID;
  existing_child_id_is_idempotent BOOLEAN;
BEGIN
  -- Fetch caller
  SELECT * INTO caller_profile
  FROM profiles
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Only org admins
  IF caller_profile.role != 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'Only organization administrators can supersede anchors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Fetch + LOCK the old anchor. Without FOR UPDATE two concurrent callers
  -- could both pass the status + legal-hold checks and each insert a child
  -- anchor, forking the lineage. FOR UPDATE serializes them: the second
  -- caller blocks until the first commits, then re-reads the row and sees
  -- status = 'SUPERSEDED' → raises the "already superseded" exception
  -- below. The unique partial index added at the end of this migration is
  -- belt-and-suspenders for any surviving race.
  SELECT * INTO old_anchor
  FROM anchors
  WHERE id = old_anchor_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor not found'
      USING ERRCODE = 'P0001';
  END IF;

  -- Org match
  IF old_anchor.org_id IS NULL OR old_anchor.org_id != caller_profile.org_id THEN
    RAISE EXCEPTION 'Cannot supersede anchor from a different organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Cannot supersede an already-revoked or already-superseded anchor
  IF old_anchor.status IN ('REVOKED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Anchor is already % — cannot supersede', old_anchor.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legal hold blocks supersede just as it blocks revoke
  IF old_anchor.legal_hold = true THEN
    RAISE EXCEPTION 'Cannot supersede anchor under legal hold'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Single scan over children: order by fingerprint match first. If the
  -- first row is an idempotent re-call (same fingerprint), return it;
  -- otherwise we've hit a fork attempt and must reject.
  SELECT id, (fingerprint = new_fingerprint)
    INTO existing_child_id, existing_child_id_is_idempotent
  FROM anchors
  WHERE parent_anchor_id = old_anchor_id
    AND deleted_at IS NULL
  ORDER BY (fingerprint = new_fingerprint) DESC
  LIMIT 1;

  IF existing_child_id IS NOT NULL THEN
    IF existing_child_id_is_idempotent THEN
      RETURN existing_child_id;
    END IF;
    RAISE EXCEPTION 'Anchor has already been superseded by %', existing_child_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Insert the new anchor as a child of the old one.
  INSERT INTO anchors (
    user_id, org_id, filename, fingerprint,
    status, credential_type, metadata,
    parent_anchor_id,
    description
  ) VALUES (
    old_anchor.user_id, old_anchor.org_id, old_anchor.filename, new_fingerprint,
    'PENDING'::anchor_status,
    old_anchor.credential_type,
    COALESCE(old_anchor.metadata, '{}'::jsonb),
    old_anchor_id,
    old_anchor.description
  )
  RETURNING id INTO new_anchor_id;

  -- Flip the old anchor to SUPERSEDED.
  UPDATE anchors
  SET status = 'SUPERSEDED',
      revoked_at = now(),
      revocation_reason = COALESCE(LEFT(reason, 2000), 'Superseded by newer version'),
      updated_at = now()
  WHERE id = old_anchor_id;

  -- Audit (unchanged from 0226)
  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_SUPERSEDED', 'ANCHOR',
    auth.uid(), caller_profile.email, caller_profile.org_id,
    'anchor', old_anchor_id::text,
    jsonb_build_object(
      'previous_status', old_anchor.status,
      'new_anchor_id', new_anchor_id,
      'new_fingerprint', new_fingerprint,
      'reason', LEFT(reason, 2000)
    )::text
  );

  INSERT INTO audit_events (
    event_type, event_category, actor_id, actor_email, org_id,
    target_type, target_id, details
  ) VALUES (
    'ANCHOR_CREATED', 'ANCHOR',
    auth.uid(), caller_profile.email, caller_profile.org_id,
    'anchor', new_anchor_id::text,
    jsonb_build_object(
      'parent_anchor_id', old_anchor_id,
      'supersedes_previous', true
    )::text
  );

  RETURN new_anchor_id;
END;
$$;


ALTER FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text") IS 'ARK-104: atomically supersede an anchor with a new fingerprint. Old anchor → SUPERSEDED; new anchor → PENDING with parent_anchor_id set. Idempotent on (parent, new_fingerprint).';



CREATE OR REPLACE FUNCTION "public"."suspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_actual_parent uuid;
  v_already       boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT suspended INTO v_already FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_already = true THEN
    RETURN jsonb_build_object('success', true, 'already_suspended', true);
  END IF;

  UPDATE organizations
    SET suspended        = true,
        suspended_at     = now(),
        suspended_by     = v_caller,
        suspended_reason = p_reason
    WHERE id = p_sub_org_id;

  BEGIN
    INSERT INTO audit_events (org_id, event_type, actor_user_id, payload)
    VALUES (
      p_parent_org_id,
      'org.suborg.suspended',
      v_caller,
      jsonb_build_object(
        'parent_org_id', p_parent_org_id,
        'sub_org_id',    p_sub_org_id,
        'reason',        p_reason,
        'at',            now()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'suspend_suborg: audit_events insert failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success',         true,
    'sub_org_id',      p_sub_org_id,
    'suspended_at',    now(),
    'suspended_by',    v_caller,
    'reason',          p_reason
  );
END;
$$;


ALTER FUNCTION "public"."suspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_compliance_audits_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."touch_compliance_audits_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."try_advisory_lock"("lock_id" bigint) RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT pg_try_advisory_lock(lock_id);
$$;


ALTER FUNCTION "public"."try_advisory_lock"("lock_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unsuspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_actual_parent uuid;
  v_currently     boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  SELECT parent_org_id INTO v_actual_parent
    FROM organizations WHERE id = p_sub_org_id;
  IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_child_of_parent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE user_id = v_caller AND org_id = p_parent_org_id
      AND role IN ('owner', 'admin', 'ORG_ADMIN')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'parent_admin_required');
  END IF;

  SELECT suspended INTO v_currently FROM organizations WHERE id = p_sub_org_id FOR UPDATE;
  IF v_currently = false THEN
    RETURN jsonb_build_object('success', true, 'was_already_active', true);
  END IF;

  UPDATE organizations
    SET suspended        = false,
        suspended_at     = null,
        suspended_by     = null,
        suspended_reason = null
    WHERE id = p_sub_org_id;

  BEGIN
    INSERT INTO audit_events (org_id, event_type, actor_user_id, payload)
    VALUES (
      p_parent_org_id,
      'org.suborg.unsuspended',
      v_caller,
      jsonb_build_object(
        'parent_org_id', p_parent_org_id,
        'sub_org_id',    p_sub_org_id,
        'at',            now()
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'unsuspend_suborg: audit_events insert failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('success', true, 'sub_org_id', p_sub_org_id, 'unsuspended_at', now());
END;
$$;


ALTER FUNCTION "public"."unsuspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_agents_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_agents_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_attestation_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_attestation_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_credential_embeddings_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_credential_embeddings_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_grc_connections_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_grc_connections_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_institution_ground_truth_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_institution_ground_truth_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_profile_onboarding"("p_role" "public"."user_role", "p_org_legal_name" "text" DEFAULT NULL::"text", "p_org_display_name" "text" DEFAULT NULL::"text", "p_org_domain" "text" DEFAULT NULL::"text", "p_org_type" "text" DEFAULT NULL::"text", "p_org_description" "text" DEFAULT NULL::"text", "p_org_website_url" "text" DEFAULT NULL::"text", "p_org_linkedin_url" "text" DEFAULT NULL::"text", "p_org_twitter_url" "text" DEFAULT NULL::"text", "p_org_location" "text" DEFAULT NULL::"text", "p_org_ein_tax_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_current_role user_role;
  v_current_org_id uuid;
  v_org_id uuid;
  v_display_name text;
  v_domain text;
  v_ein text;
  v_verification_status text;
  v_result jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role, org_id INTO v_current_role, v_current_org_id
  FROM profiles
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_current_role IS NOT NULL THEN
    IF v_current_role = 'ORG_ADMIN'
       AND v_current_org_id IS NULL
       AND nullif(trim(COALESCE(p_org_legal_name, '')), '') IS NOT NULL THEN
      NULL;
    ELSE
      v_result := jsonb_build_object(
        'success', true,
        'role', v_current_role::text,
        'already_set', true,
        'user_id', v_user_id
      );

      IF v_current_org_id IS NOT NULL THEN
        v_result := v_result || jsonb_build_object('org_id', v_current_org_id);
      END IF;

      RETURN v_result;
    END IF;
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  IF p_role = 'ORG_ADMIN' AND nullif(trim(COALESCE(p_org_legal_name, '')), '') IS NOT NULL THEN
    v_display_name := nullif(trim(COALESCE(p_org_display_name, '')), '');
    IF v_display_name IS NULL THEN
      v_display_name := trim(p_org_legal_name);
    END IF;

    v_domain := nullif(lower(trim(COALESCE(p_org_domain, ''))), '');
    v_ein := nullif(trim(COALESCE(p_org_ein_tax_id, '')), '');
    v_verification_status := CASE WHEN v_ein IS NULL THEN 'UNVERIFIED' ELSE 'PENDING' END;

    INSERT INTO organizations (
      legal_name,
      display_name,
      domain,
      verification_status,
      org_type,
      description,
      website_url,
      linkedin_url,
      twitter_url,
      location,
      ein_tax_id
    ) VALUES (
      trim(p_org_legal_name),
      v_display_name,
      v_domain,
      v_verification_status,
      nullif(trim(COALESCE(p_org_type, '')), ''),
      nullif(trim(COALESCE(p_org_description, '')), ''),
      nullif(trim(COALESCE(p_org_website_url, '')), ''),
      nullif(trim(COALESCE(p_org_linkedin_url, '')), ''),
      nullif(trim(COALESCE(p_org_twitter_url, '')), ''),
      nullif(trim(COALESCE(p_org_location, '')), ''),
      v_ein
    )
    RETURNING id INTO v_org_id;

    INSERT INTO org_members (user_id, org_id, role)
    VALUES (v_user_id, v_org_id, 'owner')
    ON CONFLICT (user_id, org_id) DO UPDATE
      SET role = 'owner';

    INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
    VALUES (
      'org.created',
      'ORG',
      v_user_id,
      'organization',
      v_org_id,
      v_org_id,
      format('Organization created during onboarding: %s', v_display_name)
    );

    UPDATE profiles
    SET role = 'ORG_ADMIN', org_id = v_org_id
    WHERE id = v_user_id;
  ELSE
    UPDATE profiles
    SET role = p_role
    WHERE id = v_user_id;
  END IF;

  INSERT INTO audit_events (event_type, event_category, actor_id, target_type, target_id, org_id, details)
  VALUES (
    'profile.role_set',
    'PROFILE',
    v_user_id,
    'profile',
    v_user_id,
    v_org_id,
    format('Role set to %s during onboarding', p_role::text)
  );

  v_result := jsonb_build_object(
    'success', true,
    'role', p_role::text,
    'already_set', false,
    'user_id', v_user_id
  );

  IF v_org_id IS NOT NULL THEN
    v_result := v_result || jsonb_build_object('org_id', v_org_id);
  END IF;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."update_profile_onboarding"("p_role" "public"."user_role", "p_org_legal_name" "text", "p_org_display_name" "text", "p_org_domain" "text", "p_org_type" "text", "p_org_description" "text", "p_org_website_url" "text", "p_org_linkedin_url" "text", "p_org_twitter_url" "text", "p_org_location" "text", "p_org_ein_tax_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."update_profile_onboarding"("p_role" "public"."user_role", "p_org_legal_name" "text", "p_org_display_name" "text", "p_org_domain" "text", "p_org_type" "text", "p_org_description" "text", "p_org_website_url" "text", "p_org_linkedin_url" "text", "p_org_twitter_url" "text", "p_org_location" "text", "p_org_ein_tax_id" "text") IS 'Transactional onboarding: sets role, creates organizations, and inserts org_members ownership.';



CREATE OR REPLACE FUNCTION "public"."update_public_records_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_public_records_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_review_queue_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_review_queue_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_anchors_rls_enabled"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT relrowsecurity AND relforcerowsecurity
       FROM pg_class
      WHERE relname = 'anchors'
        AND relnamespace = 'public'::regnamespace),
    false
  );
$$;


ALTER FUNCTION "public"."verify_anchors_rls_enabled"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."verify_anchors_rls_enabled"() IS 'SCRUM-1235: production smoke test "rls-active" check. Returns true iff anchors has both ENABLE and FORCE ROW LEVEL SECURITY set. Cheap pg_class lookup — does not touch row data.';



CREATE TABLE IF NOT EXISTS "public"."adobe_sign_webhook_nonces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "agreement_id" "text" NOT NULL,
    "webhook_id" "text",
    "payload_hash" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."adobe_sign_webhook_nonces" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."adobe_sign_webhook_nonces" OWNER TO "postgres";


COMMENT ON TABLE "public"."adobe_sign_webhook_nonces" IS 'SCRUM-1148: replay protection for Adobe Sign webhooks. Sweep entries older than 14 days.';



CREATE TABLE IF NOT EXISTS "public"."agents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "agent_type" "public"."agent_type" DEFAULT 'custom'::"public"."agent_type" NOT NULL,
    "status" "public"."agent_status" DEFAULT 'active'::"public"."agent_status" NOT NULL,
    "allowed_scopes" "text"[] DEFAULT '{verify}'::"text"[] NOT NULL,
    "registered_by" "uuid" NOT NULL,
    "framework" "text",
    "version" "text",
    "callback_url" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_active_at" timestamp with time zone,
    "suspended_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    CONSTRAINT "agents_allowed_scopes_known_values" CHECK ((("cardinality"("allowed_scopes") >= 1) AND ("allowed_scopes" <@ ARRAY['read:records'::"text", 'read:orgs'::"text", 'read:search'::"text", 'write:anchors'::"text", 'admin:rules'::"text", 'verify'::"text", 'verify:batch'::"text", 'usage:read'::"text", 'keys:manage'::"text", 'compliance:read'::"text", 'compliance:write'::"text", 'oracle:read'::"text", 'oracle:write'::"text", 'anchor:write'::"text", 'anchor:read'::"text", 'attestations:write'::"text", 'attestations:read'::"text", 'webhooks:manage'::"text", 'agents:manage'::"text", 'keys:read'::"text"]))),
    CONSTRAINT "agents_callback_https" CHECK ((("callback_url" IS NULL) OR ("callback_url" ~~ 'https://%'::"text"))),
    CONSTRAINT "agents_name_length" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 200)))
);

ALTER TABLE ONLY "public"."agents" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."agents" OWNER TO "postgres";


COMMENT ON COLUMN "public"."agents"."allowed_scopes" IS 'Canonical API key scopes an agent may receive when generating delegated keys.';



CREATE TABLE IF NOT EXISTS "public"."ai_credits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid",
    "user_id" "uuid",
    "monthly_allocation" integer DEFAULT 50 NOT NULL,
    "used_this_month" integer DEFAULT 0 NOT NULL,
    "period_start" timestamp with time zone DEFAULT "date_trunc"('month'::"text", "now"()) NOT NULL,
    "period_end" timestamp with time zone DEFAULT ("date_trunc"('month'::"text", "now"()) + '1 mon'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_credits_owner_check" CHECK ((("org_id" IS NOT NULL) OR ("user_id" IS NOT NULL)))
);

ALTER TABLE ONLY "public"."ai_credits" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_credits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "report_type" "text" NOT NULL,
    "status" "public"."ai_report_status" DEFAULT 'QUEUED'::"public"."ai_report_status" NOT NULL,
    "title" "text" NOT NULL,
    "parameters" "jsonb" DEFAULT '{}'::"jsonb",
    "result" "jsonb",
    "file_url" "text",
    "error_message" "text",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_reports_report_type_check" CHECK (("report_type" = ANY (ARRAY['integrity_summary'::"text", 'extraction_accuracy'::"text", 'credential_analytics'::"text", 'compliance_overview'::"text"])))
);

ALTER TABLE ONLY "public"."ai_reports" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."anchor_chain_index" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "fingerprint_sha256" "text" NOT NULL,
    "chain_tx_id" "text" NOT NULL,
    "chain_block_height" integer,
    "chain_block_timestamp" timestamp with time zone,
    "confirmations" integer DEFAULT 0,
    "anchor_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."anchor_chain_index" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."anchor_chain_index" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."anchor_proofs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "anchor_id" "uuid" NOT NULL,
    "receipt_id" "text" NOT NULL,
    "block_height" integer,
    "block_timestamp" timestamp with time zone,
    "merkle_root" "text",
    "proof_path" "jsonb",
    "raw_response" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "batch_id" "text"
);

ALTER TABLE ONLY "public"."anchor_proofs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."anchor_proofs" OWNER TO "postgres";


COMMENT ON TABLE "public"."anchor_proofs" IS 'Proof data for secured anchors';



COMMENT ON COLUMN "public"."anchor_proofs"."batch_id" IS 'Internal Merkle batch identifier for batch-anchored records.';



CREATE TABLE IF NOT EXISTS "public"."anchor_queue_resolutions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "external_file_id" "text" NOT NULL,
    "selected_anchor_id" "uuid" NOT NULL,
    "rejected_anchor_ids" "uuid"[] DEFAULT ARRAY[]::"uuid"[] NOT NULL,
    "reason" "text",
    "resolved_by_user_id" "uuid",
    "resolved_by_api_key_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "anchor_queue_resolutions_actor_exclusive" CHECK (((("resolved_by_user_id" IS NOT NULL) AND ("resolved_by_api_key_id" IS NULL)) OR (("resolved_by_user_id" IS NULL) AND ("resolved_by_api_key_id" IS NOT NULL)) OR (("resolved_by_user_id" IS NULL) AND ("resolved_by_api_key_id" IS NULL)))),
    CONSTRAINT "anchor_queue_resolutions_external_file_id_length" CHECK ((("char_length"("external_file_id") >= 1) AND ("char_length"("external_file_id") <= 255))),
    CONSTRAINT "anchor_queue_resolutions_reason_length" CHECK ((("reason" IS NULL) OR ("char_length"("reason") <= 2000))),
    CONSTRAINT "anchor_queue_resolutions_rejected_count" CHECK (("cardinality"("rejected_anchor_ids") <= 100))
);

ALTER TABLE ONLY "public"."anchor_queue_resolutions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."anchor_queue_resolutions" OWNER TO "postgres";


COMMENT ON TABLE "public"."anchor_queue_resolutions" IS 'ARK-101: admin or agent resolution of multi-version anchor collisions. Links the selected anchor + rejected siblings + reason.';



CREATE TABLE IF NOT EXISTS "public"."anchor_recipients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "anchor_id" "uuid" NOT NULL,
    "recipient_email_hash" "text" NOT NULL,
    "recipient_user_id" "uuid",
    "claimed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."anchor_recipients" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."anchor_recipients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."anchors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "fingerprint" character(64) NOT NULL,
    "filename" "text" NOT NULL,
    "file_size" bigint,
    "file_mime" "text",
    "status" "public"."anchor_status" DEFAULT 'PENDING'::"public"."anchor_status" NOT NULL,
    "chain_tx_id" "text",
    "chain_block_height" bigint,
    "chain_timestamp" timestamp with time zone,
    "legal_hold" boolean DEFAULT false NOT NULL,
    "retention_until" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "public_id" "text",
    "label" "text",
    "issued_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "revocation_reason" "text",
    "credential_type" "public"."credential_type",
    "metadata" "jsonb",
    "parent_anchor_id" "uuid",
    "version_number" integer DEFAULT 1 NOT NULL,
    "chain_confirmations" integer DEFAULT 0,
    "revocation_tx_id" "text",
    "revocation_block_height" integer,
    "description" "text",
    "recipient_email" "text",
    "payment_source_id" "text",
    "payment_source_type" "text",
    "compliance_controls" "jsonb",
    "sub_type" "text",
    "directory_info_opt_out" boolean DEFAULT false NOT NULL,
    "revoked_by" "uuid",
    CONSTRAINT "anchors_chain_data_consistency" CHECK ((("status" <> 'SECURED'::"public"."anchor_status") OR ("chain_tx_id" IS NOT NULL))),
    CONSTRAINT "anchors_description_max_length" CHECK ((("description" IS NULL) OR ("char_length"("description") <= 500))),
    CONSTRAINT "anchors_file_size_positive" CHECK ((("file_size" IS NULL) OR ("file_size" > 0))),
    CONSTRAINT "anchors_filename_length" CHECK ((("char_length"("filename") >= 1) AND ("char_length"("filename") <= 255))),
    CONSTRAINT "anchors_filename_no_control_chars" CHECK (("filename" !~ '[\x00-\x1F\x7F]'::"text")),
    CONSTRAINT "anchors_fingerprint_format" CHECK (("fingerprint" ~ '^[A-Fa-f0-9]{64}$'::"text")),
    CONSTRAINT "anchors_label_length" CHECK ((("label" IS NULL) OR (("char_length"("label") >= 1) AND ("char_length"("label") <= 500)))),
    CONSTRAINT "anchors_legal_hold_no_delete" CHECK ((("legal_hold" = false) OR ("deleted_at" IS NULL))),
    CONSTRAINT "anchors_lineage_root_is_v1" CHECK ((("parent_anchor_id" IS NOT NULL) OR ("version_number" = 1))),
    CONSTRAINT "anchors_metadata_is_object" CHECK ((("metadata" IS NULL) OR ("jsonb_typeof"("metadata") = 'object'::"text"))),
    CONSTRAINT "anchors_no_self_reference" CHECK ((("parent_anchor_id" IS NULL) OR ("parent_anchor_id" <> "id"))),
    CONSTRAINT "anchors_revocation_consistency" CHECK ((("revocation_reason" IS NULL) OR ("revoked_at" IS NOT NULL))),
    CONSTRAINT "anchors_revocation_reason_length" CHECK ((("revocation_reason" IS NULL) OR ("char_length"("revocation_reason") <= 2000))),
    CONSTRAINT "anchors_version_positive" CHECK (("version_number" >= 1))
)
WITH ("autovacuum_enabled"='true', "autovacuum_vacuum_cost_delay"='100', "fillfactor"='70', "autovacuum_vacuum_scale_factor"='0.005', "autovacuum_vacuum_threshold"='5000', "autovacuum_analyze_scale_factor"='0.01', "autovacuum_analyze_threshold"='5000', toast."autovacuum_vacuum_scale_factor"='0.01', toast."autovacuum_vacuum_threshold"='5000');

ALTER TABLE ONLY "public"."anchors" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."anchors" OWNER TO "postgres";


COMMENT ON TABLE "public"."anchors" IS 'Primary anchor records. SCALE-02: fillfactor/autovacuum tuned for high-write batch anchoring workload.';



COMMENT ON COLUMN "public"."anchors"."credential_type" IS 'Type of credential (DEGREE, LICENSE, CERTIFICATE, TRANSCRIPT, PROFESSIONAL, OTHER). NULL for legacy records.';



COMMENT ON COLUMN "public"."anchors"."metadata" IS 'Structured credential metadata (issuer, recipient, custom fields). Only editable while status = PENDING.';



COMMENT ON COLUMN "public"."anchors"."parent_anchor_id" IS 'Previous version of this credential (NULL for originals). Self-referencing FK.';



COMMENT ON COLUMN "public"."anchors"."version_number" IS 'Version number in lineage chain (1 = original, 2+ = updates).';



COMMENT ON COLUMN "public"."anchors"."chain_confirmations" IS 'Number of blockchain confirmations for this anchor transaction';



COMMENT ON COLUMN "public"."anchors"."description" IS 'Brief, immutable description of the credential. Set at creation, locked after PENDING.';



COMMENT ON COLUMN "public"."anchors"."recipient_email" IS 'Email of the intended recipient (set by admin during credential issuance, used for pending profile creation)';



COMMENT ON COLUMN "public"."anchors"."payment_source_id" IS 'ID of the payment that funded this anchor (subscription ID or x402 payment ID)';



COMMENT ON COLUMN "public"."anchors"."payment_source_type" IS 'Payment rail: stripe, x402, admin_bypass, beta_unlimited';



COMMENT ON COLUMN "public"."anchors"."compliance_controls" IS 'Array of regulatory control IDs applicable to this anchor (CML-02). Auto-populated on SECURED. Example: ["SOC2-CC6.1","GDPR-5.1f","FERPA-99.31"]';



COMMENT ON COLUMN "public"."anchors"."sub_type" IS 'GRE-01: Fine-grained credential sub-type (e.g., official_undergraduate, nursing_rn). Nullable.';



COMMENT ON COLUMN "public"."anchors"."revoked_by" IS 'User who revoked this anchor claim. Worker-only write via service_role.';



CREATE TABLE IF NOT EXISTS "public"."api_key_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "api_key_id" "uuid" NOT NULL,
    "month" "text" NOT NULL,
    "request_count" integer DEFAULT 0 NOT NULL,
    "last_request_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."api_key_usage" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_key_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "key_prefix" "text" NOT NULL,
    "key_hash" "text" NOT NULL,
    "name" "text" NOT NULL,
    "scopes" "text"[] DEFAULT ARRAY['read:search'::"text"] NOT NULL,
    "rate_limit_tier" "public"."api_key_rate_limit_tier" DEFAULT 'free'::"public"."api_key_rate_limit_tier" NOT NULL,
    "last_used_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "revoked_at" timestamp with time zone,
    "revocation_reason" "text",
    "ferpa_exception_category" "text",
    "institution_type" "text",
    "access_purpose" "text",
    "ferpa_verified" boolean DEFAULT false NOT NULL,
    "agent_id" "uuid",
    CONSTRAINT "api_keys_hash_not_empty" CHECK (("length"("key_hash") > 0)),
    CONSTRAINT "api_keys_name_not_empty" CHECK (("length"(TRIM(BOTH FROM "name")) > 0)),
    CONSTRAINT "api_keys_prefix_length" CHECK (("length"("key_prefix") >= 8)),
    CONSTRAINT "api_keys_scopes_known_values" CHECK ((("cardinality"("scopes") >= 1) AND ("scopes" <@ ARRAY['read:records'::"text", 'read:orgs'::"text", 'read:search'::"text", 'write:anchors'::"text", 'admin:rules'::"text", 'verify'::"text", 'verify:batch'::"text", 'usage:read'::"text", 'keys:manage'::"text", 'compliance:read'::"text", 'compliance:write'::"text", 'oracle:read'::"text", 'oracle:write'::"text", 'anchor:write'::"text", 'anchor:read'::"text", 'attestations:write'::"text", 'attestations:read'::"text", 'webhooks:manage'::"text", 'agents:manage'::"text", 'keys:read'::"text"]))),
    CONSTRAINT "chk_ferpa_exception_valid" CHECK ((("ferpa_exception_category" IS NULL) OR ("ferpa_exception_category" = ANY (ARRAY['99.31(a)(1)'::"text", '99.31(a)(2)'::"text", '99.31(a)(3)'::"text", '99.31(a)(4)'::"text", '99.31(a)(5)'::"text", '99.31(a)(6)'::"text", '99.31(a)(7)'::"text", '99.31(a)(8)'::"text", '99.31(a)(9)'::"text", '99.31(a)(10)'::"text", '99.31(a)(11)'::"text", '99.31(a)(12)'::"text", 'other'::"text", 'not_applicable'::"text"])))),
    CONSTRAINT "chk_institution_type_valid" CHECK ((("institution_type" IS NULL) OR ("institution_type" = ANY (ARRAY['k12_school'::"text", 'university'::"text", 'community_college'::"text", 'employer'::"text", 'government'::"text", 'accreditor'::"text", 'financial_aid'::"text", 'research'::"text", 'legal'::"text", 'healthcare'::"text", 'other'::"text"]))))
);

ALTER TABLE ONLY "public"."api_keys" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_keys" OWNER TO "postgres";


COMMENT ON COLUMN "public"."api_keys"."scopes" IS 'Canonical API key scope vocabulary: read:records, read:orgs, read:search, write:anchors, admin:rules, verify, verify:batch, usage:read, keys:manage, compliance:read, compliance:write, oracle:read, oracle:write, anchor:write, anchor:read, attestations:write, attestations:read, webhooks:manage, agents:manage, keys:read.';



CREATE TABLE IF NOT EXISTS "public"."ats_integrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "webhook_secret" "text" NOT NULL,
    "callback_url" "text",
    "field_mapping" "jsonb" DEFAULT '{}'::"jsonb",
    "enabled" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ats_integrations_provider_check" CHECK (("provider" = ANY (ARRAY['greenhouse'::"text", 'lever'::"text", 'generic'::"text"])))
);

ALTER TABLE ONLY "public"."ats_integrations" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ats_integrations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ats_webhook_nonces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "integration_id" "uuid" NOT NULL,
    "signature" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ats_webhook_nonces_provider_check" CHECK (("provider" = ANY (ARRAY['greenhouse'::"text", 'lever'::"text", 'generic'::"text"])))
);

ALTER TABLE ONLY "public"."ats_webhook_nonces" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ats_webhook_nonces" OWNER TO "postgres";


COMMENT ON TABLE "public"."ats_webhook_nonces" IS 'SCRUM-1242 / AUDIT-0424-26: replay protection for ATS webhook deliveries (Greenhouse / Lever / generic). Dedupes on (provider, integration_id, signature). Sweep entries older than 14 days.';



CREATE TABLE IF NOT EXISTS "public"."attestation_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "attestation_id" "uuid" NOT NULL,
    "evidence_type" "text" DEFAULT 'document'::"text" NOT NULL,
    "fingerprint" "text" NOT NULL,
    "filename" "text",
    "description" "text",
    "uploaded_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "public_id" "text" DEFAULT ('AEV-'::"text" || "upper"("replace"(("gen_random_uuid"())::"text", '-'::"text", ''::"text"))) NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint,
    CONSTRAINT "attestation_evidence_public_id_format" CHECK (("public_id" ~ '^AEV-[A-F0-9]{32}$'::"text")),
    CONSTRAINT "attestation_evidence_size_nonnegative" CHECK ((("size_bytes" IS NULL) OR ("size_bytes" >= 0)))
);

ALTER TABLE ONLY "public"."attestation_evidence" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."attestation_evidence" OWNER TO "postgres";


COMMENT ON COLUMN "public"."attestation_evidence"."public_id" IS 'Stable public identifier for an evidence row. Internal id remains private.';



COMMENT ON COLUMN "public"."attestation_evidence"."mime_type" IS 'Optional MIME type for the fingerprinted evidence item.';



COMMENT ON COLUMN "public"."attestation_evidence"."size_bytes" IS 'Optional byte size for the fingerprinted evidence item.';



CREATE TABLE IF NOT EXISTS "public"."attestations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "public_id" "text" NOT NULL,
    "anchor_id" "uuid",
    "subject_type" "text" DEFAULT 'credential'::"text" NOT NULL,
    "subject_identifier" "text" NOT NULL,
    "attester_org_id" "uuid",
    "attester_user_id" "uuid" NOT NULL,
    "attester_name" "text" NOT NULL,
    "attester_type" "public"."attester_type" DEFAULT 'INSTITUTION'::"public"."attester_type" NOT NULL,
    "attester_title" "text",
    "attestation_type" "public"."attestation_type" NOT NULL,
    "claims" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "summary" "text",
    "jurisdiction" "text",
    "evidence_fingerprint" "text",
    "status" "public"."attestation_status" DEFAULT 'DRAFT'::"public"."attestation_status" NOT NULL,
    "fingerprint" "text",
    "chain_tx_id" "text",
    "chain_block_height" integer,
    "chain_timestamp" timestamp with time zone,
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "revocation_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb"
);

ALTER TABLE ONLY "public"."attestations" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."attestations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "event_category" "text" NOT NULL,
    "actor_id" "uuid",
    "target_type" "text",
    "target_id" "text",
    "org_id" "uuid",
    "details" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_events_details_length" CHECK ((("details" IS NULL) OR ("char_length"("details") <= 10000))),
    CONSTRAINT "audit_events_event_category_valid" CHECK (("event_category" = ANY (ARRAY['AUTH'::"text", 'ANCHOR'::"text", 'PROFILE'::"text", 'ORG'::"text", 'ADMIN'::"text", 'SYSTEM'::"text", 'ORGANIZATION'::"text", 'WEBHOOK'::"text", 'API'::"text", 'AI'::"text", 'BILLING'::"text", 'VERIFICATION'::"text", 'USER'::"text"]))),
    CONSTRAINT "audit_events_event_type_length" CHECK ((("char_length"("event_type") >= 1) AND ("char_length"("event_type") <= 100))),
    CONSTRAINT "audit_events_target_type_length" CHECK ((("target_type" IS NULL) OR ("char_length"("target_type") <= 50)))
)
WITH ("autovacuum_vacuum_scale_factor"='0.05', "autovacuum_analyze_scale_factor"='0.02');

ALTER TABLE ONLY "public"."audit_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."audit_events" IS 'Append-only audit log. Writes are service_role-only via POST /api/audit/event (SCRUM-1270, 2026-04-27). Browser-direct inserts disabled to satisfy SOC-2 CC7.2 immutability. Pre-2026-04-27 rows may have been browser-originated.';



CREATE TABLE IF NOT EXISTS "public"."audit_events_archive" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "event_category" "text" NOT NULL,
    "actor_id" "uuid",
    "actor_email" "text",
    "actor_ip" "inet",
    "actor_user_agent" "text",
    "target_type" "text",
    "target_id" "text",
    "org_id" "uuid",
    "details" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_events_details_length" CHECK ((("details" IS NULL) OR ("char_length"("details") <= 10000))),
    CONSTRAINT "audit_events_event_category_valid" CHECK (("event_category" = ANY (ARRAY['AUTH'::"text", 'ANCHOR'::"text", 'PROFILE'::"text", 'ORG'::"text", 'ADMIN'::"text", 'SYSTEM'::"text", 'ORGANIZATION'::"text", 'WEBHOOK'::"text", 'API'::"text", 'AI'::"text", 'BILLING'::"text", 'VERIFICATION'::"text", 'USER'::"text"]))),
    CONSTRAINT "audit_events_event_type_length" CHECK ((("char_length"("event_type") >= 1) AND ("char_length"("event_type") <= 100))),
    CONSTRAINT "audit_events_target_type_length" CHECK ((("target_type" IS NULL) OR ("char_length"("target_type") <= 50)))
);

ALTER TABLE ONLY "public"."audit_events_archive" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_events_archive" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."batch_verification_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "api_key_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "public_ids" "text"[] NOT NULL,
    "total" integer DEFAULT 0 NOT NULL,
    "results" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "batch_verification_jobs_status_check" CHECK (("status" = ANY (ARRAY['submitted'::"text", 'processing'::"text", 'complete'::"text", 'failed'::"text"])))
);

ALTER TABLE ONLY "public"."batch_verification_jobs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."batch_verification_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkr_webhook_nonces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "text" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."checkr_webhook_nonces" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."checkr_webhook_nonces" OWNER TO "postgres";


COMMENT ON TABLE "public"."checkr_webhook_nonces" IS 'SCRUM-1030/1151: replay protection for Checkr Webhook v1 deliveries. Sweep entries older than 14 days.';



CREATE TABLE IF NOT EXISTS "public"."cloud_logging_queue" (
    "id" bigint NOT NULL,
    "audit_id" "uuid" NOT NULL,
    "enqueued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "retry_count" smallint DEFAULT 0 NOT NULL,
    "last_error" "text"
);

ALTER TABLE ONLY "public"."cloud_logging_queue" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."cloud_logging_queue" OWNER TO "postgres";


COMMENT ON TABLE "public"."cloud_logging_queue" IS 'GCP-MAX-03: buffer for audit_events → Cloud Logging. Worker drains via /jobs/cloud-logging-drain every minute. Deletes rows on confirmed write.';



CREATE SEQUENCE IF NOT EXISTS "public"."cloud_logging_queue_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cloud_logging_queue_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."cloud_logging_queue_id_seq" OWNED BY "public"."cloud_logging_queue"."id";



CREATE TABLE IF NOT EXISTS "public"."compliance_audits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "triggered_by" "uuid",
    "overall_score" smallint NOT NULL,
    "overall_grade" "text" NOT NULL,
    "per_jurisdiction" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "gaps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "quarantines" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'COMPLETED'::"text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "duration_ms" integer,
    "error_code" "text",
    "error_message" "text",
    "jurisdiction_filter" "text"[],
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "compliance_audits_overall_grade_check" CHECK (("overall_grade" = ANY (ARRAY['A'::"text", 'B'::"text", 'C'::"text", 'D'::"text", 'F'::"text"]))),
    CONSTRAINT "compliance_audits_overall_score_check" CHECK ((("overall_score" >= 0) AND ("overall_score" <= 100))),
    CONSTRAINT "compliance_audits_status_check" CHECK (("status" = ANY (ARRAY['QUEUED'::"text", 'RUNNING'::"text", 'COMPLETED'::"text", 'FAILED'::"text"])))
);

ALTER TABLE ONLY "public"."compliance_audits" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."compliance_audits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."compliance_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "jurisdiction_code" "text" NOT NULL,
    "industry_code" "text" NOT NULL,
    "score" smallint NOT NULL,
    "grade" "text" NOT NULL,
    "present_documents" "jsonb" DEFAULT '[]'::"jsonb",
    "missing_documents" "jsonb" DEFAULT '[]'::"jsonb",
    "expiring_documents" "jsonb" DEFAULT '[]'::"jsonb",
    "recommendations" "jsonb" DEFAULT '[]'::"jsonb",
    "nessie_analysis_id" "uuid",
    "last_calculated" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "compliance_scores_grade_check" CHECK (("grade" = ANY (ARRAY['A'::"text", 'B'::"text", 'C'::"text", 'D'::"text", 'F'::"text"]))),
    CONSTRAINT "compliance_scores_score_check" CHECK ((("score" >= 0) AND ("score" <= 100)))
);

ALTER TABLE ONLY "public"."compliance_scores" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."compliance_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connector_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "vendor_subscription_id" "text" NOT NULL,
    "resource_id" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_renewed_at" timestamp with time zone,
    "last_renewal_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "connector_subscriptions_last_renewal_error_check" CHECK ((("last_renewal_error" IS NULL) OR ("char_length"("last_renewal_error") <= 1000))),
    CONSTRAINT "connector_subscriptions_provider_check" CHECK (("provider" = ANY (ARRAY['google_drive'::"text", 'microsoft_graph'::"text"]))),
    CONSTRAINT "connector_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'degraded'::"text", 'revoked'::"text"]))),
    CONSTRAINT "connector_subscriptions_vendor_subscription_id_check" CHECK ((("char_length"("vendor_subscription_id") >= 1) AND ("char_length"("vendor_subscription_id") <= 500)))
);

ALTER TABLE ONLY "public"."connector_subscriptions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."connector_subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."connector_subscriptions" IS 'SCRUM-1146/1147: per-org Drive/Graph watch channels + subscriptions. Renewal job sweeps expires_at; health dashboard reads status + last_renewal_error.';



CREATE TABLE IF NOT EXISTS "public"."credential_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "anchor_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "embedding" "public"."vector"(768) NOT NULL,
    "model_version" "text" DEFAULT 'text-embedding-004'::"text" NOT NULL,
    "source_text_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."credential_embeddings" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."credential_embeddings" OWNER TO "postgres";


COMMENT ON TABLE "public"."credential_embeddings" IS 'Vector embeddings for credential metadata, enabling semantic search (P8-S10). Generated from PII-stripped metadata only (Constitution 4A).';



COMMENT ON COLUMN "public"."credential_embeddings"."embedding" IS '768-dimensional vector embedding for cosine similarity search.';



COMMENT ON COLUMN "public"."credential_embeddings"."model_version" IS 'Embedding model version used to generate this vector (e.g., text-embedding-004).';



COMMENT ON COLUMN "public"."credential_embeddings"."source_text_hash" IS 'SHA-256 hash of the PII-stripped source text, for deduplication and re-embedding detection.';



CREATE TABLE IF NOT EXISTS "public"."credential_portfolios" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "public_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "attestation_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "anchor_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE ONLY "public"."credential_portfolios" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."credential_portfolios" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."credential_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "credential_type" "public"."credential_type" NOT NULL,
    "default_metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    CONSTRAINT "credential_templates_description_length" CHECK ((("description" IS NULL) OR ("char_length"("description") <= 2000))),
    CONSTRAINT "credential_templates_metadata_is_object" CHECK ((("default_metadata" IS NULL) OR ("jsonb_typeof"("default_metadata") = 'object'::"text"))),
    CONSTRAINT "credential_templates_name_length" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 255)))
);

ALTER TABLE ONLY "public"."credential_templates" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."credential_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."credit_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "transaction_type" "public"."credit_transaction_type" NOT NULL,
    "amount" integer NOT NULL,
    "balance_after" integer NOT NULL,
    "reason" "text",
    "reference_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."credit_transactions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."credit_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."credits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "balance" integer DEFAULT 0 NOT NULL,
    "monthly_allocation" integer DEFAULT 0 NOT NULL,
    "purchased" integer DEFAULT 0 NOT NULL,
    "cycle_start" timestamp with time zone,
    "cycle_end" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "credits_balance_check" CHECK (("balance" >= 0))
);

ALTER TABLE ONLY "public"."credits" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."credits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."data_subject_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "request_type" "text" NOT NULL,
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "data_subject_requests_completed_when_done" CHECK (((("status" = 'processing'::"text") AND ("completed_at" IS NULL)) OR (("status" = ANY (ARRAY['completed'::"text", 'rejected'::"text", 'failed'::"text"])) AND ("completed_at" IS NOT NULL)))),
    CONSTRAINT "data_subject_requests_status_valid" CHECK (("status" = ANY (ARRAY['processing'::"text", 'completed'::"text", 'rejected'::"text", 'failed'::"text"]))),
    CONSTRAINT "data_subject_requests_type_valid" CHECK (("request_type" = ANY (ARRAY['export'::"text", 'correction'::"text", 'erasure'::"text", 'restriction'::"text", 'portability'::"text"])))
);

ALTER TABLE ONLY "public"."data_subject_requests" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."data_subject_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."data_subject_requests" IS 'REG-11: audit log of every data subject rights request (GDPR Art. 15-18, Kenya DPA s. 31)';



CREATE TABLE IF NOT EXISTS "public"."docusign_webhook_nonces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "envelope_id" "text" NOT NULL,
    "event_id" "text" NOT NULL,
    "generated_at" timestamp with time zone NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."docusign_webhook_nonces" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."docusign_webhook_nonces" OWNER TO "postgres";


COMMENT ON TABLE "public"."docusign_webhook_nonces" IS 'SCRUM-1101: replay protection for DocuSign Connect webhooks. Dedupes on (envelope_id, event_id, generated_at). Sweep entries older than 14 days; HMAC freshness window already rejects older deliveries.';



CREATE TABLE IF NOT EXISTS "public"."drive_folder_path_cache" (
    "org_id" "uuid" NOT NULL,
    "file_id" "text" NOT NULL,
    "folder_path" "text",
    "cached_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."drive_folder_path_cache" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."drive_folder_path_cache" OWNER TO "postgres";


COMMENT ON TABLE "public"."drive_folder_path_cache" IS 'SCRUM-1169: Short-lived cache (15 min TTL enforced at app layer) of Drive file_id → human folder path, keyed by org to avoid cross-tenant path leakage.';



CREATE TABLE IF NOT EXISTS "public"."drive_revision_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "integration_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "file_id" "text" NOT NULL,
    "revision_id" "text" NOT NULL,
    "parent_ids" "text"[],
    "modified_time" timestamp with time zone,
    "actor_email" "text",
    "outcome" "text" NOT NULL,
    "rule_event_id" "uuid",
    "processed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "drive_revision_ledger_outcome_check" CHECK (("outcome" = ANY (ARRAY['queued'::"text", 'parent_mismatch'::"text", 'unrelated_change'::"text"])))
);

ALTER TABLE ONLY "public"."drive_revision_ledger" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."drive_revision_ledger" OWNER TO "postgres";


COMMENT ON TABLE "public"."drive_revision_ledger" IS 'SCRUM-1650 GD-07: revision-level dedupe + audit log for Drive changes.list processing. Unique on (integration_id, file_id, revision_id). Sweep entries older than 90 days (separate retention job).';



CREATE TABLE IF NOT EXISTS "public"."drive_webhook_nonces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "channel_id" "text" NOT NULL,
    "message_number" bigint NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."drive_webhook_nonces" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."drive_webhook_nonces" OWNER TO "postgres";


COMMENT ON TABLE "public"."drive_webhook_nonces" IS 'SCRUM-1242 / AUDIT-0424-26: replay protection for Drive push notifications. Dedupes on (channel_id, message_number) — Google''s monotonic per-channel counter. Sweep entries older than 14 days.';



CREATE TABLE IF NOT EXISTS "public"."emergency_access_grants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "grantee_id" "uuid" NOT NULL,
    "approver_id" "uuid",
    "reason" "text" NOT NULL,
    "scope" "text" DEFAULT 'healthcare_credentials'::"text" NOT NULL,
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    "revoke_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."emergency_access_grants" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."emergency_access_grants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entitlements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "org_id" "uuid",
    "entitlement_type" "text" NOT NULL,
    "value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" DEFAULT 'subscription'::"text" NOT NULL,
    "valid_from" timestamp with time zone DEFAULT "now"() NOT NULL,
    "valid_until" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "entitlements_has_owner" CHECK ((("user_id" IS NOT NULL) OR ("org_id" IS NOT NULL))),
    CONSTRAINT "entitlements_source_check" CHECK (("source" = ANY (ARRAY['subscription'::"text", 'manual'::"text", 'trial'::"text", 'promo'::"text"])))
);

ALTER TABLE ONLY "public"."entitlements" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."entitlements" OWNER TO "postgres";


COMMENT ON TABLE "public"."entitlements" IS 'Current entitlements for users/orgs';



CREATE TABLE IF NOT EXISTS "public"."extraction_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid",
    "user_id" "uuid",
    "anchor_id" "uuid",
    "fingerprint" "text" NOT NULL,
    "credential_type" "text" NOT NULL,
    "field_key" "text" NOT NULL,
    "original_value" "text",
    "corrected_value" "text",
    "action" "text" NOT NULL,
    "original_confidence" numeric(4,3),
    "provider" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "extraction_feedback_action_check" CHECK (("action" = ANY (ARRAY['accepted'::"text", 'rejected'::"text", 'edited'::"text"]))),
    CONSTRAINT "extraction_feedback_original_confidence_check" CHECK ((("original_confidence" >= (0)::numeric) AND ("original_confidence" <= (1)::numeric)))
);

ALTER TABLE ONLY "public"."extraction_feedback" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."extraction_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."extraction_manifests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "fingerprint" character(64) NOT NULL,
    "model_id" "text" NOT NULL,
    "model_version" "text" NOT NULL,
    "extracted_fields" "jsonb" NOT NULL,
    "confidence_scores" "jsonb" NOT NULL,
    "manifest_hash" character(64) NOT NULL,
    "anchor_id" "uuid",
    "usage_event_id" "uuid",
    "org_id" "uuid",
    "user_id" "uuid",
    "extraction_timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    "prompt_version" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "zk_proof" "jsonb",
    "zk_public_signals" "jsonb",
    "zk_proof_protocol" "text",
    "zk_circuit_version" "text",
    "zk_poseidon_hash" character(64),
    "zk_proof_generated_at" timestamp with time zone,
    "zk_proof_generation_ms" integer
);

ALTER TABLE ONLY "public"."extraction_manifests" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."extraction_manifests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ferpa_disclosure_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "requesting_party_name" "text" NOT NULL,
    "requesting_party_type" "public"."ferpa_party_type" DEFAULT 'other'::"public"."ferpa_party_type" NOT NULL,
    "requesting_party_org" "text",
    "legitimate_interest" "text" NOT NULL,
    "disclosure_exception" "public"."ferpa_exception_category" DEFAULT 'other'::"public"."ferpa_exception_category" NOT NULL,
    "education_record_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "student_opt_out_checked" boolean DEFAULT false NOT NULL,
    "student_consent_obtained" boolean DEFAULT false NOT NULL,
    "api_key_id" "uuid",
    "verification_event_id" "uuid",
    "disclosed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "disclosed_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."ferpa_disclosure_log" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."ferpa_disclosure_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_month" "text" NOT NULL,
    "stripe_revenue_usd" numeric(12,2) DEFAULT 0,
    "x402_revenue_usd" numeric(12,2) DEFAULT 0,
    "total_revenue_usd" numeric(12,2) DEFAULT 0,
    "bitcoin_fee_sats" bigint DEFAULT 0,
    "bitcoin_fee_usd" numeric(12,2) DEFAULT 0,
    "total_anchors" integer DEFAULT 0,
    "avg_cost_per_anchor_usd" numeric(8,4) DEFAULT 0,
    "gross_margin_usd" numeric(12,2) DEFAULT 0,
    "gross_margin_pct" numeric(5,2) DEFAULT 0,
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."financial_reports" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."freemail_domains" (
    "domain" "text" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."freemail_domains" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."freemail_domains" OWNER TO "postgres";


COMMENT ON TABLE "public"."freemail_domains" IS 'SCRUM-1161: Canonical free-mail domains that must never auto-match an organization. Prevents attacker-registered free-mail accounts from auto-joining orgs that happened to register with the same personal address.';



CREATE TABLE IF NOT EXISTS "public"."grc_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "platform" "public"."grc_platform" NOT NULL,
    "access_token_encrypted" "text",
    "refresh_token_encrypted" "text",
    "token_expires_at" timestamp with time zone,
    "external_org_id" "text",
    "external_workspace_id" "text",
    "scopes" "text"[] DEFAULT '{}'::"text"[],
    "is_active" boolean DEFAULT true NOT NULL,
    "last_sync_at" timestamp with time zone,
    "last_sync_status" "public"."grc_sync_status",
    "last_sync_error" "text",
    "sync_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid" NOT NULL
);

ALTER TABLE ONLY "public"."grc_connections" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."grc_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."grc_sync_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "anchor_id" "uuid",
    "status" "public"."grc_sync_status" DEFAULT 'pending'::"public"."grc_sync_status" NOT NULL,
    "evidence_type" "text" DEFAULT 'anchor_secured'::"text" NOT NULL,
    "external_evidence_id" "text",
    "error_message" "text",
    "request_payload" "jsonb",
    "response_payload" "jsonb",
    "duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."grc_sync_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."grc_sync_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."institution_ground_truth" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "institution_name" "text" NOT NULL,
    "domain" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "embedding" "public"."vector"(768),
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "confidence_score" numeric(3,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "institution_ground_truth_confidence_score_check" CHECK ((("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (1)::numeric)))
);

ALTER TABLE ONLY "public"."institution_ground_truth" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."institution_ground_truth" OWNER TO "postgres";


COMMENT ON TABLE "public"."institution_ground_truth" IS 'Institution verification ground truth data with vector embeddings for similarity search. Used by P8 anomaly detection (INFRA-08).';



COMMENT ON COLUMN "public"."institution_ground_truth"."embedding" IS '768-dimensional vector embedding for semantic similarity search.';



COMMENT ON COLUMN "public"."institution_ground_truth"."source" IS 'Data source: cloudflare_crawl, manual, api, etc.';



COMMENT ON COLUMN "public"."institution_ground_truth"."confidence_score" IS 'Confidence score 0.00-1.00 indicating data reliability.';



CREATE TABLE IF NOT EXISTS "public"."integration_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "integration_id" "uuid",
    "provider" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "status" "text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "integration_events_provider_check" CHECK (("provider" = ANY (ARRAY['google_drive'::"text", 'microsoft_graph'::"text", 'docusign'::"text", 'adobe_sign'::"text"]))),
    CONSTRAINT "integration_events_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'warning'::"text", 'error'::"text"])))
);

ALTER TABLE ONLY "public"."integration_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."integration_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."integration_events" IS 'SCRUM-1168: Append-only audit log of integration connect / renewal / webhook events. Non-sensitive metadata only; token bodies never land here.';



CREATE TABLE IF NOT EXISTS "public"."integrity_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "anchor_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "overall_score" numeric(5,2) NOT NULL,
    "level" "public"."integrity_level" NOT NULL,
    "metadata_completeness" numeric(5,2) DEFAULT 0,
    "extraction_confidence" numeric(5,2) DEFAULT 0,
    "issuer_verification" numeric(5,2) DEFAULT 0,
    "duplicate_check" numeric(5,2) DEFAULT 0,
    "temporal_consistency" numeric(5,2) DEFAULT 0,
    "flags" "jsonb" DEFAULT '[]'::"jsonb",
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "integrity_scores_overall_score_check" CHECK ((("overall_score" >= (0)::numeric) AND ("overall_score" <= (100)::numeric)))
);

ALTER TABLE ONLY "public"."integrity_scores" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."integrity_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invitations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "email" "text" NOT NULL,
    "role" "public"."user_role" DEFAULT 'INDIVIDUAL'::"public"."user_role" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "invited_by" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "token" "uuid" DEFAULT "extensions"."uuid_generate_v4"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone,
    CONSTRAINT "invitations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'expired'::"text", 'revoked'::"text"])))
);

ALTER TABLE ONLY "public"."invitations" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."invitations" OWNER TO "postgres";


COMMENT ON TABLE "public"."invitations" IS 'Pending member invitations for organizations';



CREATE TABLE IF NOT EXISTS "public"."jurisdiction_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "jurisdiction_code" "text" NOT NULL,
    "industry_code" "text" NOT NULL,
    "rule_name" "text" NOT NULL,
    "required_credential_types" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "optional_credential_types" "text"[] DEFAULT '{}'::"text"[],
    "regulatory_reference" "text",
    "effective_date" "date",
    "expiry_date" "date",
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."jurisdiction_rules" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."jurisdiction_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kyb_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "status" "text" NOT NULL,
    "provider_event_id" "text",
    "payload_hash" "text",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "kyb_events_provider_check" CHECK (("provider" = ANY (ARRAY['middesk'::"text", 'manual'::"text"]))),
    CONSTRAINT "kyb_events_status_check" CHECK (("status" = ANY (ARRAY['submitted'::"text", 'pending'::"text", 'verified'::"text", 'requires_input'::"text", 'rejected'::"text", 'error'::"text"])))
);

ALTER TABLE ONLY "public"."kyb_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."kyb_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."kyb_events" IS 'SCRUM-1162: Append-only audit trail of KYB verification events. PII from the vendor payload (EIN, address) is NEVER persisted here — only the hash of the raw webhook bytes for replay-dedup.';



CREATE TABLE IF NOT EXISTS "public"."kyb_webhook_nonces" (
    "provider" "text" NOT NULL,
    "nonce" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."kyb_webhook_nonces" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."kyb_webhook_nonces" OWNER TO "postgres";


COMMENT ON TABLE "public"."kyb_webhook_nonces" IS 'SCRUM-1162: Short-term nonce store for KYB webhook replay protection. Partitioned by provider to avoid accidental cross-vendor nonce collisions.';



CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "role" "public"."user_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."memberships" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."memberships" OWNER TO "postgres";


CREATE MATERIALIZED VIEW "public"."mv_anchor_status_counts" AS
 SELECT ("status")::"text" AS "status",
    "count"(*) AS "cnt"
   FROM "public"."anchors"
  WHERE ("deleted_at" IS NULL)
  GROUP BY "status"
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."mv_anchor_status_counts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."public_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source" "text" NOT NULL,
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "record_type" "text" NOT NULL,
    "title" "text",
    "content_hash" "text" NOT NULL,
    "anchor_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "training_exported" boolean DEFAULT false
)
WITH ("autovacuum_vacuum_scale_factor"='0.02', "autovacuum_analyze_scale_factor"='0.01');

ALTER TABLE ONLY "public"."public_records" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."public_records" OWNER TO "postgres";


COMMENT ON TABLE "public"."public_records" IS 'Ingested public records from EDGAR, USPTO, Federal Register, OpenAlex for Nessie RAG pipeline';



COMMENT ON COLUMN "public"."public_records"."training_exported" IS 'Set to true after record is exported to Nessie training JSONL';



CREATE MATERIALIZED VIEW "public"."mv_public_records_source_counts" AS
 SELECT "source",
    "count"(*) AS "cnt"
   FROM "public"."public_records"
  GROUP BY "source"
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."mv_public_records_source_counts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "link" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "notifications_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "notifications_type_check" CHECK (("type" = ANY (ARRAY['REGULATORY_CHANGE'::"text", 'AUDIT_COMPLETED'::"text", 'BREACH_ALERT'::"text"])))
);

ALTER TABLE ONLY "public"."notifications" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_credit_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "parent_org_id" "uuid" NOT NULL,
    "child_org_id" "uuid" NOT NULL,
    "amount" integer NOT NULL,
    "effective_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "granted_by" "uuid" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "one_level_only" CHECK (("parent_org_id" <> "child_org_id"))
);

ALTER TABLE ONLY "public"."org_credit_allocations" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_credit_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_credits" (
    "org_id" "uuid" NOT NULL,
    "balance" integer DEFAULT 0 NOT NULL,
    "monthly_allocation" integer DEFAULT 0 NOT NULL,
    "purchased" integer DEFAULT 0 NOT NULL,
    "cycle_start" timestamp with time zone DEFAULT "date_trunc"('month'::"text", "now"()) NOT NULL,
    "cycle_end" timestamp with time zone DEFAULT ("date_trunc"('month'::"text", "now"()) + '1 mon'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "org_credits_balance_check" CHECK (("balance" >= 0)),
    CONSTRAINT "org_credits_monthly_allocation_check" CHECK (("monthly_allocation" >= 0)),
    CONSTRAINT "org_credits_purchased_check" CHECK (("purchased" >= 0))
);

ALTER TABLE ONLY "public"."org_credits" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_credits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_daily_usage" (
    "org_id" "uuid" NOT NULL,
    "usage_date" "date" DEFAULT (("now"() AT TIME ZONE 'UTC'::"text"))::"date" NOT NULL,
    "quota_kind" "text" NOT NULL,
    "count" bigint DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "org_daily_usage_kind_shape" CHECK (("quota_kind" ~ '^[a-z_]{3,50}$'::"text"))
);

ALTER TABLE ONLY "public"."org_daily_usage" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_daily_usage" OWNER TO "postgres";


COMMENT ON TABLE "public"."org_daily_usage" IS 'SCALE-01 per-org per-day per-quota counters. Middleware increments; rollover is implicit via usage_date PK.';



CREATE TABLE IF NOT EXISTS "public"."org_integrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "account_id" "text",
    "account_label" "text",
    "encrypted_tokens" "bytea",
    "token_kms_key_id" "text",
    "scope" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone,
    "subscription_id" "text",
    "subscription_expires_at" timestamp with time zone,
    "last_renewal_at" timestamp with time zone,
    "last_renewal_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_page_token" "text",
    "last_token_advanced_at" timestamp with time zone,
    "watch_renewal_failure_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "org_integrations_provider_check" CHECK (("provider" = ANY (ARRAY['google_drive'::"text", 'microsoft_graph'::"text", 'docusign'::"text", 'adobe_sign'::"text"])))
);

ALTER TABLE ONLY "public"."org_integrations" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_integrations" OWNER TO "postgres";


COMMENT ON TABLE "public"."org_integrations" IS 'SCRUM-1168: Per-org per-provider integration state. encrypted_tokens is KMS-encrypted; cleartext tokens never land in Postgres.';



COMMENT ON COLUMN "public"."org_integrations"."encrypted_tokens" IS 'KMS-encrypted JSON blob of OAuth tokens. Never log. Decrypt only in the worker before making provider API calls.';



COMMENT ON COLUMN "public"."org_integrations"."last_page_token" IS 'SCRUM-1650 GD-03: Drive changes.list page token. Advanced on every successful processing pass; resumed on worker restart so we never miss a change. Null until the first page-token bootstrap (changes.getStartPageToken). Currently Drive-specific; other providers leave null.';



COMMENT ON COLUMN "public"."org_integrations"."last_token_advanced_at" IS 'SCRUM-1650 GD-03: timestamp of the last page-token advance. Lets the operator see when Drive last yielded a new token vs. when the integration silently drifted.';



COMMENT ON COLUMN "public"."org_integrations"."watch_renewal_failure_count" IS 'SCRUM-1650 GD-02: consecutive watch-renewal failures. Reset to 0 on success. The renewal monitor emits drive.watch.renewal_failed when this hits 3, marks the integration health as degraded, and pages the operator.';



CREATE TABLE IF NOT EXISTS "public"."org_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "role" "public"."org_member_role" DEFAULT 'member'::"public"."org_member_role" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "invited_by" "uuid"
);

ALTER TABLE ONLY "public"."org_members" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_members" OWNER TO "postgres";


COMMENT ON TABLE "public"."org_members" IS 'Junction table: users can belong to multiple organizations with per-org roles';



COMMENT ON COLUMN "public"."org_members"."role" IS 'owner = created the org, admin = can manage members/settings, member = can view records';



CREATE TABLE IF NOT EXISTS "public"."org_monthly_allocation" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "base_allocation" integer DEFAULT 0 NOT NULL,
    "rolled_over_balance" integer DEFAULT 0 NOT NULL,
    "anchor_fee_credits" integer DEFAULT 0 NOT NULL,
    "used_this_cycle" integer DEFAULT 0 NOT NULL,
    "closed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "org_monthly_allocation_anchor_fee_credits_check" CHECK (("anchor_fee_credits" >= 0)),
    CONSTRAINT "org_monthly_allocation_base_allocation_check" CHECK (("base_allocation" >= 0)),
    CONSTRAINT "org_monthly_allocation_rolled_over_balance_check" CHECK (("rolled_over_balance" >= 0)),
    CONSTRAINT "org_monthly_allocation_used_this_cycle_check" CHECK (("used_this_cycle" >= 0))
);

ALTER TABLE ONLY "public"."org_monthly_allocation" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_monthly_allocation" OWNER TO "postgres";


COMMENT ON TABLE "public"."org_monthly_allocation" IS 'SCRUM-1164: Anchor allocation bookkeeping per org per calendar month. Append-only per period; cycle-close job writes the NEXT period row, never rewrites prior.';



CREATE TABLE IF NOT EXISTS "public"."org_tier_entitlements" (
    "tier_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "price_cents" integer,
    "billing_period" "text" DEFAULT 'month'::"text" NOT NULL,
    "included_admins" integer,
    "included_seats" integer,
    "anchors_per_month" integer,
    "included_sub_orgs" integer DEFAULT 0 NOT NULL,
    "additional_seat_price_cents" integer,
    "additional_seat_anchor_increment" integer,
    "max_self_serve_seats" integer,
    "requires_quote" boolean DEFAULT false NOT NULL,
    "can_create_sub_orgs" boolean DEFAULT false NOT NULL,
    "features" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "org_tier_entitlements_billing_period_check" CHECK (("billing_period" = ANY (ARRAY['month'::"text", 'year'::"text", 'custom'::"text"])))
);

ALTER TABLE ONLY "public"."org_tier_entitlements" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_tier_entitlements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_rule_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "trigger_type" "public"."org_rule_trigger_type" NOT NULL,
    "vendor" "text",
    "external_file_id" "text",
    "filename" "text",
    "folder_path" "text",
    "sender_email" "text",
    "subject" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "public"."org_rule_event_status" DEFAULT 'PENDING'::"public"."org_rule_event_status" NOT NULL,
    "claim_id" "uuid",
    "claimed_at" timestamp with time zone,
    "processed_at" timestamp with time zone,
    "attempt_count" smallint DEFAULT 0 NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organization_rule_events_claim_consistency" CHECK (((("status" = 'CLAIMED'::"public"."org_rule_event_status") AND ("claim_id" IS NOT NULL) AND ("claimed_at" IS NOT NULL)) OR ("status" <> 'CLAIMED'::"public"."org_rule_event_status"))),
    CONSTRAINT "organization_rule_events_error_length" CHECK ((("error" IS NULL) OR ("char_length"("error") <= 4000))),
    CONSTRAINT "organization_rule_events_external_file_id_length" CHECK ((("external_file_id" IS NULL) OR (("char_length"("external_file_id") >= 1) AND ("char_length"("external_file_id") <= 500)))),
    CONSTRAINT "organization_rule_events_filename_length" CHECK ((("filename" IS NULL) OR ("char_length"("filename") <= 500))),
    CONSTRAINT "organization_rule_events_folder_path_length" CHECK ((("folder_path" IS NULL) OR ("char_length"("folder_path") <= 2000))),
    CONSTRAINT "organization_rule_events_payload_size" CHECK (("pg_column_size"("payload") <= 16384)),
    CONSTRAINT "organization_rule_events_sender_email_length" CHECK ((("sender_email" IS NULL) OR ("char_length"("sender_email") <= 320))),
    CONSTRAINT "organization_rule_events_subject_length" CHECK ((("subject" IS NULL) OR ("char_length"("subject") <= 500))),
    CONSTRAINT "organization_rule_events_vendor_length" CHECK ((("vendor" IS NULL) OR (("char_length"("vendor") >= 1) AND ("char_length"("vendor") <= 50))))
);

ALTER TABLE ONLY "public"."organization_rule_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_rule_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."organization_rule_events" IS 'Durable sanitized trigger-event queue for org-defined custom rules. Claimed by ARK-106 rules-engine worker.';



COMMENT ON COLUMN "public"."organization_rule_events"."payload" IS 'Provider-specific event metadata (e.g. Drive parent_ids, file_id) used by rule binding filters. Sanitized; no raw bodies.';



CREATE TABLE IF NOT EXISTS "public"."organization_rule_executions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rule_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "trigger_event_id" "text" NOT NULL,
    "status" "public"."org_rule_execution_status" DEFAULT 'PENDING'::"public"."org_rule_execution_status" NOT NULL,
    "input_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "output_payload" "jsonb",
    "error" "text",
    "attempt_count" smallint DEFAULT 0 NOT NULL,
    "duration_ms" integer,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organization_rule_executions_error_length" CHECK ((("error" IS NULL) OR ("char_length"("error") <= 4000))),
    CONSTRAINT "organization_rule_executions_trigger_event_id_length" CHECK ((("char_length"("trigger_event_id") >= 1) AND ("char_length"("trigger_event_id") <= 255)))
);

ALTER TABLE ONLY "public"."organization_rule_executions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_rule_executions" OWNER TO "postgres";


COMMENT ON TABLE "public"."organization_rule_executions" IS 'Per-execution record for every rule firing. Permanent UNIQUE(rule_id, trigger_event_id) enforces ARK-106 idempotency — same external event never replays, even months later. See migration 0224 for the index.';



CREATE TABLE IF NOT EXISTS "public"."organization_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "trigger_type" "public"."org_rule_trigger_type" NOT NULL,
    "trigger_config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "action_type" "public"."org_rule_action_type" NOT NULL,
    "action_config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "schema_version" smallint DEFAULT 1 NOT NULL,
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_executed_at" timestamp with time zone,
    "execution_count" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "organization_rules_action_config_size" CHECK (("pg_column_size"("action_config") <= 16384)),
    CONSTRAINT "organization_rules_description_length" CHECK ((("description" IS NULL) OR ("char_length"("description") <= 1000))),
    CONSTRAINT "organization_rules_name_length" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 100))),
    CONSTRAINT "organization_rules_trigger_config_size" CHECK (("pg_column_size"("trigger_config") <= 16384))
);

ALTER TABLE ONLY "public"."organization_rules" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_rules" OWNER TO "postgres";


COMMENT ON TABLE "public"."organization_rules" IS 'Org-configurable automation rules. Trigger on event types; dispatch action types; config in JSONB validated by Zod at write-path.';



COMMENT ON COLUMN "public"."organization_rules"."schema_version" IS 'Bump when trigger_config / action_config schema changes incompatibly.';



CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "legal_name" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "domain" "text",
    "verification_status" "text" DEFAULT 'UNVERIFIED'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "public_id" "text",
    "org_prefix" "text",
    "description" "text",
    "website_url" "text",
    "logo_url" "text",
    "founded_date" "date",
    "org_type" "text",
    "linkedin_url" "text",
    "location" "text",
    "ein_tax_id" "text",
    "domain_verified" boolean DEFAULT false,
    "domain_verification_method" "text",
    "domain_verified_at" timestamp with time zone,
    "domain_verification_token" "text",
    "domain_verification_token_expires_at" timestamp with time zone,
    "parent_org_id" "uuid",
    "parent_approval_status" "text",
    "parent_approved_at" timestamp with time zone,
    "max_sub_orgs" integer,
    "affiliation_fee_status" "text",
    "affiliation_grace_expires_at" timestamp with time zone,
    "twitter_url" "text",
    "industry_tag" "text",
    "directory_info_fields" "text"[] DEFAULT ARRAY['name'::"text", 'degree_type'::"text", 'dates_of_attendance'::"text", 'enrollment_status'::"text", 'honors'::"text"] NOT NULL,
    "hipaa_mfa_required" boolean DEFAULT false NOT NULL,
    "session_timeout_minutes" integer DEFAULT 0 NOT NULL,
    "tier" "public"."org_tier" DEFAULT 'FREE'::"public"."org_tier" NOT NULL,
    "kyb_provider" "text",
    "kyb_reference_id" "text",
    "kyb_submitted_at" timestamp with time zone,
    "kyb_completed_at" timestamp with time zone,
    "payment_state" "text",
    "payment_grace_expires_at" timestamp with time zone,
    "payment_state_updated_at" timestamp with time zone,
    "banner_url" "text",
    "verified_badge_granted_at" timestamp with time zone,
    "suspended" boolean DEFAULT false NOT NULL,
    "suspended_at" timestamp with time zone,
    "suspended_by" "uuid",
    "suspended_reason" "text",
    CONSTRAINT "organizations_affiliation_fee_status_check" CHECK ((("affiliation_fee_status" IS NULL) OR ("affiliation_fee_status" = ANY (ARRAY['ACTIVE'::"text", 'GRACE'::"text", 'LAPSED'::"text"])))),
    CONSTRAINT "organizations_display_name_length" CHECK ((("char_length"("display_name") >= 1) AND ("char_length"("display_name") <= 255))),
    CONSTRAINT "organizations_domain_format" CHECK ((("domain" IS NULL) OR ("domain" ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'::"text"))),
    CONSTRAINT "organizations_domain_verification_method_check" CHECK ((("domain_verification_method" IS NULL) OR ("domain_verification_method" = ANY (ARRAY['email'::"text", 'dns'::"text"])))),
    CONSTRAINT "organizations_ein_format" CHECK ((("ein_tax_id" IS NULL) OR ("length"("ein_tax_id") >= 5))),
    CONSTRAINT "organizations_industry_tag_check" CHECK ((("industry_tag" IS NULL) OR ("industry_tag" = ANY (ARRAY['higher_ed'::"text", 'legal_tech'::"text", 'fintech'::"text", 'healthcare'::"text", 'government'::"text", 'insurance'::"text", 'real_estate'::"text", 'accounting'::"text", 'human_resources'::"text", 'cybersecurity'::"text", 'energy'::"text", 'manufacturing'::"text", 'retail'::"text", 'media'::"text", 'nonprofit'::"text", 'consulting'::"text", 'aerospace'::"text", 'biotech'::"text", 'other'::"text"])))),
    CONSTRAINT "organizations_kyb_provider_check" CHECK ((("kyb_provider" IS NULL) OR ("kyb_provider" = ANY (ARRAY['middesk'::"text", 'manual'::"text"])))),
    CONSTRAINT "organizations_legal_name_length" CHECK ((("char_length"("legal_name") >= 1) AND ("char_length"("legal_name") <= 255))),
    CONSTRAINT "organizations_parent_approval_status_check" CHECK ((("parent_approval_status" IS NULL) OR ("parent_approval_status" = ANY (ARRAY['PENDING'::"text", 'APPROVED'::"text", 'REVOKED'::"text"])))),
    CONSTRAINT "organizations_payment_state_check" CHECK ((("payment_state" IS NULL) OR ("payment_state" = ANY (ARRAY['grace'::"text", 'suspended'::"text", 'ok'::"text"])))),
    CONSTRAINT "organizations_verification_status_valid" CHECK (("verification_status" = ANY (ARRAY['UNVERIFIED'::"text", 'PENDING'::"text", 'VERIFIED'::"text"])))
);

ALTER TABLE ONLY "public"."organizations" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."organizations"."description" IS 'Public-facing organization description';



COMMENT ON COLUMN "public"."organizations"."website_url" IS 'Organization website URL';



COMMENT ON COLUMN "public"."organizations"."logo_url" IS 'Organization logo URL (uploaded or external)';



COMMENT ON COLUMN "public"."organizations"."founded_date" IS 'Organization founding date';



COMMENT ON COLUMN "public"."organizations"."org_type" IS 'Organization type: corporation, university, government, nonprofit, law_firm, other';



COMMENT ON COLUMN "public"."organizations"."linkedin_url" IS 'LinkedIn company page URL';



COMMENT ON COLUMN "public"."organizations"."location" IS 'Organization headquarters location';



COMMENT ON COLUMN "public"."organizations"."ein_tax_id" IS 'EIN/Tax ID for verified orgs — UNIQUE, L3 Confidential (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."domain_verified" IS 'Whether the org domain has been verified via email or DNS (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."domain_verification_method" IS 'How domain was verified: email or dns (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."domain_verified_at" IS 'When domain was verified (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."domain_verification_token" IS 'Token for email-based domain verification (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."domain_verification_token_expires_at" IS 'Expiry for domain verification token (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."parent_org_id" IS 'Parent org for sub-org affiliation — one level deep only (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."parent_approval_status" IS 'Sub-org approval: PENDING, APPROVED, REVOKED (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."max_sub_orgs" IS 'Admin-set cap on affiliated sub-orgs (IDT WS4)';



COMMENT ON COLUMN "public"."organizations"."twitter_url" IS 'X/Twitter profile URL';



COMMENT ON COLUMN "public"."organizations"."industry_tag" IS 'Standardized industry identifier for public sorting/filtering';



COMMENT ON COLUMN "public"."organizations"."tier" IS 'SCALE-01 pricing tier — drives per-org rate limits + feature gating. FREE by default.';



COMMENT ON COLUMN "public"."organizations"."kyb_provider" IS 'SCRUM-1162: Vendor that last produced this org''s verification result. NULL = never submitted.';



COMMENT ON COLUMN "public"."organizations"."kyb_reference_id" IS 'SCRUM-1162: Opaque vendor-side reference (e.g. Middesk business_id). Never log.';



COMMENT ON COLUMN "public"."organizations"."kyb_submitted_at" IS 'When the org was first submitted for KYB verification (any vendor).';



COMMENT ON COLUMN "public"."organizations"."kyb_completed_at" IS 'When the most recent KYB verification reached a terminal state (verified / rejected).';



COMMENT ON COLUMN "public"."organizations"."payment_state" IS 'SCRUM-1166: NULL = healthy; "grace" = card declined, 3d window; "suspended" = grace expired, writes blocked; "ok" = post-recovery sentinel.';



COMMENT ON COLUMN "public"."organizations"."payment_grace_expires_at" IS 'SCRUM-1166: Timer authoritative to Arkova. Stripe smart_retries is belt-and-suspenders.';



COMMENT ON COLUMN "public"."organizations"."suspended" IS 'SCRUM-1652 ORG-08: when true, the org is barred from new anchors / queue runs / integration-trigger actions. Existing evidence remains readable.';



CREATE TABLE IF NOT EXISTS "public"."parent_split_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_org_id" "uuid" NOT NULL,
    "parent_org_id" "uuid" NOT NULL,
    "issued_to_user_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."parent_split_tokens" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."parent_split_tokens" OWNER TO "postgres";


COMMENT ON TABLE "public"."parent_split_tokens" IS 'SCRUM-1167: single-use, 30-day tokens emailed to sub-org admins when their parent org becomes payment-suspended. Landing flow lives in Phase 3b.';



CREATE TABLE IF NOT EXISTS "public"."payment_grace_periods" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "stripe_subscription_id" "text",
    "grace_start" timestamp with time zone DEFAULT "now"() NOT NULL,
    "grace_end" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notification_sent" boolean DEFAULT false NOT NULL,
    "downgraded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_grace_periods_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'resolved'::"text"])))
);

ALTER TABLE ONLY "public"."payment_grace_periods" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_grace_periods" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_dashboard_cache" (
    "cache_key" "text" NOT NULL,
    "cache_value" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."pipeline_dashboard_cache" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_dashboard_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plans" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "stripe_price_id" "text",
    "price_cents" integer DEFAULT 0 NOT NULL,
    "billing_period" "text" DEFAULT 'month'::"text" NOT NULL,
    "records_per_month" integer DEFAULT 10 NOT NULL,
    "features" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "plans_billing_period_check" CHECK (("billing_period" = ANY (ARRAY['month'::"text", 'year'::"text", 'custom'::"text"])))
);

ALTER TABLE ONLY "public"."plans" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."plans" IS 'Available subscription plans';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "role" "public"."user_role",
    "role_set_at" timestamp with time zone,
    "org_id" "uuid",
    "requires_manual_review" boolean DEFAULT false NOT NULL,
    "manual_review_reason" "text",
    "manual_review_completed_at" timestamp with time zone,
    "manual_review_completed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_public_profile" boolean DEFAULT false NOT NULL,
    "is_verified" boolean DEFAULT false NOT NULL,
    "subscription_tier" "text" DEFAULT 'free'::"text" NOT NULL,
    "public_id" "text",
    "deleted_at" timestamp with time zone,
    "status" "public"."profile_status" DEFAULT 'ACTIVE'::"public"."profile_status",
    "activation_token" "text",
    "activation_token_expires_at" timestamp with time zone,
    "is_platform_admin" boolean DEFAULT false NOT NULL,
    "phone_number" "text",
    "identity_verification_status" "text" DEFAULT 'unstarted'::"text",
    "identity_verification_session_id" "text",
    "identity_verified_at" timestamp with time zone,
    "phone_verified_at" timestamp with time zone,
    "kyc_provider" "text",
    "disclaimer_accepted_at" timestamp with time zone,
    "bio" "text",
    "social_links" "jsonb",
    CONSTRAINT "profiles_bio_length" CHECK ((("bio" IS NULL) OR ("length"("bio") <= 500))),
    CONSTRAINT "profiles_email_format" CHECK (("email" ~ '^[^@]+@[^@]+\.[^@]+$'::"text")),
    CONSTRAINT "profiles_email_length" CHECK (("char_length"("email") <= 255)),
    CONSTRAINT "profiles_full_name_length" CHECK ((("full_name" IS NULL) OR ("char_length"("full_name") <= 255))),
    CONSTRAINT "profiles_identity_verification_status_check" CHECK (("identity_verification_status" = ANY (ARRAY['unstarted'::"text", 'pending'::"text", 'verified'::"text", 'requires_input'::"text", 'canceled'::"text"]))),
    CONSTRAINT "profiles_kyc_provider_check" CHECK ((("kyc_provider" IS NULL) OR ("kyc_provider" = ANY (ARRAY['stripe_identity'::"text", 'dev_bypass'::"text"])))),
    CONSTRAINT "profiles_manual_review_reason" CHECK (((("requires_manual_review" = false) AND ("manual_review_reason" IS NULL)) OR ("requires_manual_review" = true))),
    CONSTRAINT "profiles_phone_e164" CHECK ((("phone_number" IS NULL) OR ("phone_number" ~ '^\+[1-9]\d{1,14}$'::"text"))),
    CONSTRAINT "profiles_subscription_tier_check" CHECK (("subscription_tier" = ANY (ARRAY['free'::"text", 'starter'::"text", 'professional'::"text", 'enterprise'::"text", 'individual'::"text", 'organization'::"text", 'verified_individual'::"text", 'org_free'::"text", 'small_business'::"text", 'medium_business'::"text"])))
);

ALTER TABLE ONLY "public"."profiles" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."is_verified" IS 'Whether the user identity has been verified by an admin. Only settable by service_role.';



COMMENT ON COLUMN "public"."profiles"."subscription_tier" IS 'Current billing tier. Only settable by service_role via billing system.';



COMMENT ON COLUMN "public"."profiles"."status" IS 'Profile lifecycle status: ACTIVE (normal), PENDING_ACTIVATION (created by admin, awaiting recipient activation), DEACTIVATED (soft-disabled)';



COMMENT ON COLUMN "public"."profiles"."activation_token" IS 'One-time activation token for pending profiles (hex, 64 chars). Cleared on activation.';



COMMENT ON COLUMN "public"."profiles"."activation_token_expires_at" IS 'Expiry for activation token (7 days from creation)';



COMMENT ON COLUMN "public"."profiles"."phone_number" IS 'User phone number in E.164 format, optional (IDT-03)';



COMMENT ON COLUMN "public"."profiles"."identity_verification_status" IS 'Stripe Identity verification status (IDT-03)';



COMMENT ON COLUMN "public"."profiles"."identity_verification_session_id" IS 'Stripe Identity VerificationSession ID (IDT-03)';



COMMENT ON COLUMN "public"."profiles"."identity_verified_at" IS 'Timestamp when identity was verified (IDT-03)';



COMMENT ON COLUMN "public"."profiles"."phone_verified_at" IS 'When phone number was verified via SMS (IDT WS1)';



COMMENT ON COLUMN "public"."profiles"."kyc_provider" IS 'Which KYC provider verified the identity: stripe_identity or dev_bypass (IDT WS1)';



CREATE OR REPLACE VIEW "public"."public_org_profiles" WITH ("security_invoker"='true') AS
 SELECT "id",
    "display_name",
    "domain",
    "description",
    "website_url",
    "logo_url",
    "founded_date",
    "org_type",
    "linkedin_url",
    "twitter_url",
    "location",
    "industry_tag",
    "verification_status",
    "created_at"
   FROM "public"."organizations";


ALTER VIEW "public"."public_org_profiles" OWNER TO "postgres";


COMMENT ON VIEW "public"."public_org_profiles" IS 'security_invoker=true (SCRUM-1276 / R3-3) — RLS evaluated against caller, not view owner. Field list intentionally excludes ein_tax_id, domain_verification_token, parent relationships, financial data.';



CREATE TABLE IF NOT EXISTS "public"."public_record_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "public_record_id" "uuid" NOT NULL,
    "embedding" "public"."vector"(768),
    "model_version" "text" DEFAULT 'text-embedding-004'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."public_record_embeddings" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."public_record_embeddings" OWNER TO "postgres";


COMMENT ON TABLE "public"."public_record_embeddings" IS 'Vector embeddings for public records — used by Nessie RAG query endpoint';



CREATE TABLE IF NOT EXISTS "public"."reconciliation_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_month" "text" NOT NULL,
    "report_type" "text" NOT NULL,
    "total_revenue_usd" numeric(12,2),
    "total_cost_usd" numeric(12,2),
    "total_anchors" integer,
    "discrepancies" "jsonb" DEFAULT '[]'::"jsonb",
    "summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reconciliation_reports_report_type_check" CHECK (("report_type" = ANY (ARRAY['stripe_anchor'::"text", 'x402_api'::"text", 'financial'::"text"])))
);

ALTER TABLE ONLY "public"."reconciliation_reports" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."reconciliation_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."report_artifacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "uuid" NOT NULL,
    "filename" "text" NOT NULL,
    "mime_type" "text" DEFAULT 'application/json'::"text" NOT NULL,
    "file_size" integer,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."report_artifacts" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."report_artifacts" OWNER TO "postgres";


COMMENT ON TABLE "public"."report_artifacts" IS 'Generated report files';



CREATE TABLE IF NOT EXISTS "public"."reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "report_type" "public"."report_type" NOT NULL,
    "parameters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "public"."report_status" DEFAULT 'pending'::"public"."report_status" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "idempotency_key" "text"
);

ALTER TABLE ONLY "public"."reports" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."reports" IS 'Report requests and metadata';



CREATE TABLE IF NOT EXISTS "public"."review_queue_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "anchor_id" "uuid" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "integrity_score_id" "uuid",
    "status" "public"."review_status" DEFAULT 'PENDING'::"public"."review_status" NOT NULL,
    "priority" integer DEFAULT 0 NOT NULL,
    "reason" "text" NOT NULL,
    "flags" "jsonb" DEFAULT '[]'::"jsonb",
    "assigned_to" "uuid",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_notes" "text",
    "review_action" "public"."review_action",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "review_queue_items_priority_check" CHECK ((("priority" >= 0) AND ("priority" <= 10)))
);

ALTER TABLE ONLY "public"."review_queue_items" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."review_queue_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rule_embeddings" (
    "content_hash" "text" NOT NULL,
    "model_version" "text" NOT NULL,
    "embedding" "text" NOT NULL,
    "dimensions" smallint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rule_embeddings_dimensions_check" CHECK ((("dimensions" >= 64) AND ("dimensions" <= 4096))),
    CONSTRAINT "rule_embeddings_hash_shape" CHECK (("content_hash" ~ '^[a-f0-9]{64}$'::"text"))
);

ALTER TABLE ONLY "public"."rule_embeddings" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."rule_embeddings" OWNER TO "postgres";


COMMENT ON TABLE "public"."rule_embeddings" IS 'ARK-109 cache of vector embeddings for rule descriptions + document metadata. Keyed by SHA-256 of normalized content + model_version for clean invalidation on model upgrade.';



CREATE TABLE IF NOT EXISTS "public"."signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "public_id" "text" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "anchor_id" "uuid",
    "attestation_id" "uuid",
    "format" "text" NOT NULL,
    "level" "text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "jurisdiction" "text",
    "document_fingerprint" "text" NOT NULL,
    "signer_certificate_id" "uuid" NOT NULL,
    "signer_name" "text",
    "signer_org" "text",
    "signature_value" "text",
    "signed_attributes" "jsonb",
    "signature_algorithm" "text",
    "timestamp_token_id" "uuid",
    "ltv_data_embedded" boolean DEFAULT false NOT NULL,
    "archive_timestamp_id" "uuid",
    "reason" "text",
    "location" "text",
    "contact_info" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signed_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "revocation_reason" "text",
    "created_by" "uuid" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "signatures_anchor_or_attestation" CHECK ((("anchor_id" IS NOT NULL) OR ("attestation_id" IS NOT NULL))),
    CONSTRAINT "signatures_format_check" CHECK (("format" = ANY (ARRAY['XAdES'::"text", 'PAdES'::"text", 'CAdES'::"text"]))),
    CONSTRAINT "signatures_jurisdiction_check" CHECK (("jurisdiction" = ANY (ARRAY['EU'::"text", 'US'::"text", 'UK'::"text", 'CH'::"text", 'INTL'::"text"]))),
    CONSTRAINT "signatures_level_check" CHECK (("level" = ANY (ARRAY['B-B'::"text", 'B-T'::"text", 'B-LT'::"text", 'B-LTA'::"text"]))),
    CONSTRAINT "signatures_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'SIGNED'::"text", 'TIMESTAMPED'::"text", 'LTV_EMBEDDED'::"text", 'COMPLETE'::"text", 'FAILED'::"text", 'REVOKED'::"text"])))
);

ALTER TABLE ONLY "public"."signatures" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."signatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signing_certificates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "subject_cn" "text" NOT NULL,
    "subject_org" "text",
    "issuer_cn" "text" NOT NULL,
    "issuer_org" "text",
    "serial_number" "text" NOT NULL,
    "fingerprint_sha256" "text" NOT NULL,
    "certificate_pem" "text" NOT NULL,
    "chain_pem" "text"[],
    "kms_provider" "text" NOT NULL,
    "kms_key_id" "text" NOT NULL,
    "key_algorithm" "text" NOT NULL,
    "not_before" timestamp with time zone NOT NULL,
    "not_after" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "trust_level" "text" DEFAULT 'ADVANCED'::"text" NOT NULL,
    "qtsp_name" "text",
    "eu_trusted_list_entry" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "signing_certificates_kms_provider_check" CHECK (("kms_provider" = ANY (ARRAY['aws_kms'::"text", 'gcp_kms'::"text"]))),
    CONSTRAINT "signing_certificates_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'EXPIRED'::"text", 'REVOKED'::"text", 'SUSPENDED'::"text"]))),
    CONSTRAINT "signing_certificates_trust_level_check" CHECK (("trust_level" = ANY (ARRAY['BASIC'::"text", 'ADVANCED'::"text", 'QUALIFIED'::"text"])))
);

ALTER TABLE ONLY "public"."signing_certificates" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."signing_certificates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stats_cache" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."stats_cache" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."stats_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "plan_id" "text" NOT NULL,
    "stripe_subscription_id" "text",
    "stripe_customer_id" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscriptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'past_due'::"text", 'canceled'::"text", 'trialing'::"text", 'paused'::"text"])))
);

ALTER TABLE ONLY "public"."subscriptions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."subscriptions" IS 'User subscription state';



CREATE TABLE IF NOT EXISTS "public"."switchboard_flag_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "flag_key" "text" NOT NULL,
    "old_value" boolean,
    "new_value" boolean NOT NULL,
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."switchboard_flag_history" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."switchboard_flag_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."switchboard_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "flag_key" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."switchboard_flags" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."switchboard_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."timestamp_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "signature_id" "uuid",
    "message_imprint" "text" NOT NULL,
    "hash_algorithm" "text" DEFAULT 'SHA-256'::"text" NOT NULL,
    "tst_data" "bytea" NOT NULL,
    "tst_serial" "text" NOT NULL,
    "tst_gen_time" timestamp with time zone NOT NULL,
    "tsa_name" "text" NOT NULL,
    "tsa_url" "text" NOT NULL,
    "tsa_cert_fingerprint" "text" NOT NULL,
    "qtsp_qualified" boolean DEFAULT false NOT NULL,
    "token_type" "text" DEFAULT 'SIGNATURE'::"text" NOT NULL,
    "cost_usd" numeric(10,4),
    "provider_ref" "text",
    "verified_at" timestamp with time zone,
    "verification_status" "text" DEFAULT 'UNVERIFIED'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "timestamp_tokens_token_type_check" CHECK (("token_type" = ANY (ARRAY['SIGNATURE'::"text", 'ARCHIVE'::"text", 'CONTENT'::"text"]))),
    CONSTRAINT "timestamp_tokens_verification_status_check" CHECK (("verification_status" = ANY (ARRAY['UNVERIFIED'::"text", 'VALID'::"text", 'INVALID'::"text", 'EXPIRED'::"text"])))
);

ALTER TABLE ONLY "public"."timestamp_tokens" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."timestamp_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."treasury_alert_state" (
    "key" "text" NOT NULL,
    "below_threshold" boolean DEFAULT false NOT NULL,
    "last_balance_usd" numeric(20,4),
    "last_reason" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "treasury_alert_state_key_length" CHECK ((("char_length"("key") >= 1) AND ("char_length"("key") <= 64)))
);

ALTER TABLE ONLY "public"."treasury_alert_state" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."treasury_alert_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."treasury_alert_state" IS 'ARK-103 dedup state. Singleton keyed by alert kind (currently "low_balance").';



CREATE TABLE IF NOT EXISTS "public"."treasury_cache" (
    "id" integer DEFAULT 1 NOT NULL,
    "balance_confirmed_sats" bigint DEFAULT 0 NOT NULL,
    "balance_unconfirmed_sats" bigint DEFAULT 0 NOT NULL,
    "utxo_count" integer DEFAULT 0 NOT NULL,
    "btc_price_usd" numeric(12,2),
    "fee_fastest" integer,
    "fee_half_hour" integer,
    "fee_hour" integer,
    "fee_economy" integer,
    "fee_minimum" integer,
    "block_height" integer,
    "network_name" "text",
    "last_secured_at" timestamp with time zone,
    "total_secured" bigint DEFAULT 0 NOT NULL,
    "total_pending" bigint DEFAULT 0 NOT NULL,
    "last_24h_count" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "error" "text",
    CONSTRAINT "treasury_cache_id_check" CHECK (("id" = 1))
);

ALTER TABLE ONLY "public"."treasury_cache" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."treasury_cache" OWNER TO "postgres";


COMMENT ON TABLE "public"."treasury_cache" IS 'Singleton cache for treasury balance/fees, refreshed by worker cron (SCRUM-546)';



CREATE TABLE IF NOT EXISTS "public"."unified_credits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid",
    "user_id" "uuid",
    "monthly_allocation" integer DEFAULT 50 NOT NULL,
    "used_this_month" integer DEFAULT 0 NOT NULL,
    "carry_over" integer DEFAULT 0 NOT NULL,
    "billing_cycle_start" timestamp with time zone DEFAULT "date_trunc"('month'::"text", "now"()) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "unified_credits_owner" CHECK ((("org_id" IS NOT NULL) OR ("user_id" IS NOT NULL)))
);

ALTER TABLE ONLY "public"."unified_credits" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."unified_credits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid",
    "type" "public"."notification_type" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."user_notifications" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_notifications" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_slow_queries" AS
 SELECT "queryid",
    "left"("query", 200) AS "query_preview",
    "calls",
    "round"((("total_exec_time" / (1000)::double precision))::numeric, 2) AS "total_time_sec",
    "round"(("mean_exec_time")::numeric, 2) AS "mean_time_ms",
    "round"(("max_exec_time")::numeric, 2) AS "max_time_ms",
    "round"(("stddev_exec_time")::numeric, 2) AS "stddev_ms",
    "rows"
   FROM "extensions"."pg_stat_statements"
  WHERE ("calls" > 10)
  ORDER BY "mean_exec_time" DESC
 LIMIT 50;


ALTER VIEW "public"."v_slow_queries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."verification_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "anchor_id" "uuid",
    "public_id" "text" NOT NULL,
    "method" "text" DEFAULT 'web'::"text" NOT NULL,
    "result" "text" NOT NULL,
    "fingerprint_provided" boolean DEFAULT false NOT NULL,
    "ip_hash" "text",
    "user_agent" "text",
    "referrer" "text",
    "country_code" character(2),
    "org_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "verification_events_method_check" CHECK (("method" = ANY (ARRAY['web'::"text", 'api'::"text", 'embed'::"text", 'qr'::"text"]))),
    CONSTRAINT "verification_events_public_id_length" CHECK ((("char_length"("public_id") >= 1) AND ("char_length"("public_id") <= 50))),
    CONSTRAINT "verification_events_result_check" CHECK (("result" = ANY (ARRAY['verified'::"text", 'revoked'::"text", 'not_found'::"text", 'error'::"text"])))
);

ALTER TABLE ONLY "public"."verification_events" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."verification_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."verification_events" IS 'Analytics: tracks public verification lookups (no PII)';



COMMENT ON COLUMN "public"."verification_events"."method" IS 'How the verification was initiated: web, api, embed, qr';



COMMENT ON COLUMN "public"."verification_events"."result" IS 'Outcome: verified, revoked, not_found, error';



COMMENT ON COLUMN "public"."verification_events"."ip_hash" IS 'SHA-256 hash of requester IP (never raw IP)';



CREATE TABLE IF NOT EXISTS "public"."webhook_dead_letter_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "endpoint_url" "text" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_id" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "error_message" "text" NOT NULL,
    "last_attempt" integer DEFAULT 0 NOT NULL,
    "failed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved" boolean DEFAULT false NOT NULL,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."webhook_dead_letter_queue" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."webhook_dead_letter_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."webhook_delivery_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "attempt_number" integer DEFAULT 1 NOT NULL,
    "status" "text" NOT NULL,
    "response_status" integer,
    "response_body" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "delivered_at" timestamp with time zone,
    "next_retry_at" timestamp with time zone,
    "idempotency_key" "text",
    "public_id" "text" DEFAULT ('DLV-'::"text" || "upper"(SUBSTRING("replace"(("gen_random_uuid"())::"text", '-'::"text", ''::"text") FROM 1 FOR 16))) NOT NULL,
    CONSTRAINT "webhook_delivery_logs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'success'::"text", 'failed'::"text", 'retrying'::"text"])))
);

ALTER TABLE ONLY "public"."webhook_delivery_logs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."webhook_delivery_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."webhook_delivery_logs" IS 'Delivery attempts for audit and retry logic';



COMMENT ON COLUMN "public"."webhook_delivery_logs"."public_id" IS 'Customer-facing identifier (DLV-{16}). Stable across v1+v2 — see SCRUM-1445.';



CREATE TABLE IF NOT EXISTS "public"."webhook_dlq" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "external_id" "text",
    "webhook_id" "text",
    "reason" "text" NOT NULL,
    "payload_hash" "text",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "webhook_dlq_provider_check" CHECK ((("char_length"("provider") >= 1) AND ("char_length"("provider") <= 50))),
    CONSTRAINT "webhook_dlq_reason_check" CHECK (("char_length"("reason") <= 500))
);

ALTER TABLE ONLY "public"."webhook_dlq" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."webhook_dlq" OWNER TO "postgres";


COMMENT ON TABLE "public"."webhook_dlq" IS 'SCRUM-1148: inbound webhook intake failures (HMAC-valid payloads that failed normalization or enqueue). Distinct from webhook_dead_letter_queue (0052), which tracks outbound delivery failures.';



CREATE TABLE IF NOT EXISTS "public"."webhook_endpoints" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "url" "text" NOT NULL,
    "secret_hash" "text" NOT NULL,
    "events" "text"[] DEFAULT ARRAY['anchor.secured'::"text", 'anchor.revoked'::"text"] NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "public_id" "text" NOT NULL,
    CONSTRAINT "webhook_endpoints_url_valid" CHECK (("url" ~ '^https://'::"text"))
);

ALTER TABLE ONLY "public"."webhook_endpoints" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."webhook_endpoints" OWNER TO "postgres";


COMMENT ON TABLE "public"."webhook_endpoints" IS 'Org-level webhook configuration. Secret is write-only.';



COMMENT ON COLUMN "public"."webhook_endpoints"."secret_hash" IS 'HMAC secret hash - never returned to client';



COMMENT ON COLUMN "public"."webhook_endpoints"."public_id" IS 'Customer-facing identifier (WHK-{org_prefix}-{16}). Stable across v1+v2 — see SCRUM-1445.';



ALTER TABLE ONLY "public"."cloud_logging_queue" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cloud_logging_queue_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."adobe_sign_webhook_nonces"
    ADD CONSTRAINT "adobe_sign_webhook_nonces_agreement_id_payload_hash_key" UNIQUE ("agreement_id", "payload_hash");



ALTER TABLE ONLY "public"."adobe_sign_webhook_nonces"
    ADD CONSTRAINT "adobe_sign_webhook_nonces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_credits"
    ADD CONSTRAINT "ai_credits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_reports"
    ADD CONSTRAINT "ai_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage_events"
    ADD CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."anchor_chain_index"
    ADD CONSTRAINT "anchor_chain_index_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."anchor_proofs"
    ADD CONSTRAINT "anchor_proofs_anchor_unique" UNIQUE ("anchor_id");



ALTER TABLE ONLY "public"."anchor_proofs"
    ADD CONSTRAINT "anchor_proofs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."anchor_queue_resolutions"
    ADD CONSTRAINT "anchor_queue_resolutions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."anchor_recipients"
    ADD CONSTRAINT "anchor_recipients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."anchor_recipients"
    ADD CONSTRAINT "anchor_recipients_unique" UNIQUE ("anchor_id", "recipient_email_hash");



ALTER TABLE ONLY "public"."anchors"
    ADD CONSTRAINT "anchors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."anchors"
    ADD CONSTRAINT "anchors_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."api_key_usage"
    ADD CONSTRAINT "api_key_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_key_usage"
    ADD CONSTRAINT "api_key_usage_unique_key_month" UNIQUE ("api_key_id", "month");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ats_integrations"
    ADD CONSTRAINT "ats_integrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ats_webhook_nonces"
    ADD CONSTRAINT "ats_webhook_nonces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ats_webhook_nonces"
    ADD CONSTRAINT "ats_webhook_nonces_provider_integration_id_signature_key" UNIQUE ("provider", "integration_id", "signature");



ALTER TABLE ONLY "public"."attestation_evidence"
    ADD CONSTRAINT "attestation_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attestations"
    ADD CONSTRAINT "attestations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attestations"
    ADD CONSTRAINT "attestations_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."audit_events"
    ADD CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."batch_verification_jobs"
    ADD CONSTRAINT "batch_verification_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_events"
    ADD CONSTRAINT "billing_events_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."billing_events"
    ADD CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_events"
    ADD CONSTRAINT "billing_events_stripe_event_id_key" UNIQUE ("stripe_event_id");



ALTER TABLE ONLY "public"."checkr_webhook_nonces"
    ADD CONSTRAINT "checkr_webhook_nonces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkr_webhook_nonces"
    ADD CONSTRAINT "checkr_webhook_nonces_report_id_payload_hash_key" UNIQUE ("report_id", "payload_hash");



ALTER TABLE ONLY "public"."cloud_logging_queue"
    ADD CONSTRAINT "cloud_logging_queue_audit_id_key" UNIQUE ("audit_id");



ALTER TABLE ONLY "public"."cloud_logging_queue"
    ADD CONSTRAINT "cloud_logging_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_audits"
    ADD CONSTRAINT "compliance_audits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."compliance_scores"
    ADD CONSTRAINT "compliance_scores_org_id_jurisdiction_code_industry_code_key" UNIQUE ("org_id", "jurisdiction_code", "industry_code");



ALTER TABLE ONLY "public"."compliance_scores"
    ADD CONSTRAINT "compliance_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connector_subscriptions"
    ADD CONSTRAINT "connector_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."credential_embeddings"
    ADD CONSTRAINT "credential_embeddings_anchor_unique" UNIQUE ("anchor_id");



ALTER TABLE ONLY "public"."credential_embeddings"
    ADD CONSTRAINT "credential_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."credential_portfolios"
    ADD CONSTRAINT "credential_portfolios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."credential_portfolios"
    ADD CONSTRAINT "credential_portfolios_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."credential_templates"
    ADD CONSTRAINT "credential_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."credit_transactions"
    ADD CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."credits"
    ADD CONSTRAINT "credits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."credits"
    ADD CONSTRAINT "credits_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."data_subject_requests"
    ADD CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."docusign_webhook_nonces"
    ADD CONSTRAINT "docusign_webhook_nonces_envelope_id_event_id_generated_at_key" UNIQUE ("envelope_id", "event_id", "generated_at");



ALTER TABLE ONLY "public"."docusign_webhook_nonces"
    ADD CONSTRAINT "docusign_webhook_nonces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drive_folder_path_cache"
    ADD CONSTRAINT "drive_folder_path_cache_pkey" PRIMARY KEY ("org_id", "file_id");



ALTER TABLE ONLY "public"."drive_revision_ledger"
    ADD CONSTRAINT "drive_revision_ledger_integration_id_file_id_revision_id_key" UNIQUE ("integration_id", "file_id", "revision_id");



ALTER TABLE ONLY "public"."drive_revision_ledger"
    ADD CONSTRAINT "drive_revision_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drive_webhook_nonces"
    ADD CONSTRAINT "drive_webhook_nonces_channel_id_message_number_key" UNIQUE ("channel_id", "message_number");



ALTER TABLE ONLY "public"."drive_webhook_nonces"
    ADD CONSTRAINT "drive_webhook_nonces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emergency_access_grants"
    ADD CONSTRAINT "emergency_access_grants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."entitlements"
    ADD CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."extraction_feedback"
    ADD CONSTRAINT "extraction_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."extraction_manifests"
    ADD CONSTRAINT "extraction_manifests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ferpa_disclosure_log"
    ADD CONSTRAINT "ferpa_disclosure_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_reports"
    ADD CONSTRAINT "financial_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."freemail_domains"
    ADD CONSTRAINT "freemail_domains_pkey" PRIMARY KEY ("domain");



ALTER TABLE ONLY "public"."grc_connections"
    ADD CONSTRAINT "grc_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."grc_sync_logs"
    ADD CONSTRAINT "grc_sync_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."institution_ground_truth"
    ADD CONSTRAINT "institution_ground_truth_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."integration_events"
    ADD CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."integrity_scores"
    ADD CONSTRAINT "integrity_scores_anchor_id_key" UNIQUE ("anchor_id");



ALTER TABLE ONLY "public"."integrity_scores"
    ADD CONSTRAINT "integrity_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_queue"
    ADD CONSTRAINT "job_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jurisdiction_rules"
    ADD CONSTRAINT "jurisdiction_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kyb_events"
    ADD CONSTRAINT "kyb_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kyb_webhook_nonces"
    ADD CONSTRAINT "kyb_webhook_nonces_pkey" PRIMARY KEY ("provider", "nonce");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_user_org_unique" UNIQUE ("user_id", "org_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_credit_allocations"
    ADD CONSTRAINT "org_credit_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_credits"
    ADD CONSTRAINT "org_credits_pkey" PRIMARY KEY ("org_id");



ALTER TABLE ONLY "public"."org_daily_usage"
    ADD CONSTRAINT "org_daily_usage_pkey" PRIMARY KEY ("org_id", "usage_date", "quota_kind");



ALTER TABLE ONLY "public"."org_integrations"
    ADD CONSTRAINT "org_integrations_org_id_provider_account_id_key" UNIQUE ("org_id", "provider", "account_id");



ALTER TABLE ONLY "public"."org_integrations"
    ADD CONSTRAINT "org_integrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_members"
    ADD CONSTRAINT "org_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_members"
    ADD CONSTRAINT "org_members_unique_membership" UNIQUE ("user_id", "org_id");



ALTER TABLE ONLY "public"."org_monthly_allocation"
    ADD CONSTRAINT "org_monthly_allocation_org_id_period_start_key" UNIQUE ("org_id", "period_start");



ALTER TABLE ONLY "public"."org_monthly_allocation"
    ADD CONSTRAINT "org_monthly_allocation_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_tier_entitlements"
    ADD CONSTRAINT "org_tier_entitlements_pkey" PRIMARY KEY ("tier_id");



ALTER TABLE ONLY "public"."organization_rule_events"
    ADD CONSTRAINT "organization_rule_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_rule_executions"
    ADD CONSTRAINT "organization_rule_executions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_rules"
    ADD CONSTRAINT "organization_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_ein_unique" UNIQUE ("ein_tax_id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."parent_split_tokens"
    ADD CONSTRAINT "parent_split_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."parent_split_tokens"
    ADD CONSTRAINT "parent_split_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."payment_grace_periods"
    ADD CONSTRAINT "payment_grace_periods_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_dashboard_cache"
    ADD CONSTRAINT "pipeline_dashboard_cache_pkey" PRIMARY KEY ("cache_key");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_stripe_price_id_key" UNIQUE ("stripe_price_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_activation_token_key" UNIQUE ("activation_token");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."public_record_embeddings"
    ADD CONSTRAINT "public_record_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."public_records"
    ADD CONSTRAINT "public_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reconciliation_reports"
    ADD CONSTRAINT "reconciliation_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."report_artifacts"
    ADD CONSTRAINT "report_artifacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."review_queue_items"
    ADD CONSTRAINT "review_queue_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rule_embeddings"
    ADD CONSTRAINT "rule_embeddings_pkey" PRIMARY KEY ("content_hash", "model_version");



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "signatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "signatures_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."signing_certificates"
    ADD CONSTRAINT "signing_certificates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signing_certificates"
    ADD CONSTRAINT "signing_certs_unique_per_org" UNIQUE ("org_id", "fingerprint_sha256");



ALTER TABLE ONLY "public"."stats_cache"
    ADD CONSTRAINT "stats_cache_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_unique" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."switchboard_flag_history"
    ADD CONSTRAINT "switchboard_flag_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."switchboard_flags"
    ADD CONSTRAINT "switchboard_flags_flag_key_key" UNIQUE ("flag_key");



ALTER TABLE ONLY "public"."switchboard_flags"
    ADD CONSTRAINT "switchboard_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."timestamp_tokens"
    ADD CONSTRAINT "timestamp_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."treasury_alert_state"
    ADD CONSTRAINT "treasury_alert_state_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."treasury_cache"
    ADD CONSTRAINT "treasury_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."unified_credits"
    ADD CONSTRAINT "unified_credits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "unique_pending_invite" UNIQUE ("email", "org_id", "status");



ALTER TABLE ONLY "public"."anchor_chain_index"
    ADD CONSTRAINT "uq_fingerprint_txid" UNIQUE ("fingerprint_sha256", "chain_tx_id");



ALTER TABLE ONLY "public"."grc_connections"
    ADD CONSTRAINT "uq_grc_org_platform" UNIQUE ("org_id", "platform");



ALTER TABLE ONLY "public"."user_notifications"
    ADD CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."verification_events"
    ADD CONSTRAINT "verification_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."webhook_dead_letter_queue"
    ADD CONSTRAINT "webhook_dead_letter_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."webhook_delivery_logs"
    ADD CONSTRAINT "webhook_delivery_logs_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."webhook_delivery_logs"
    ADD CONSTRAINT "webhook_delivery_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."webhook_dlq"
    ADD CONSTRAINT "webhook_dlq_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."x402_payments"
    ADD CONSTRAINT "x402_payments_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "anchors_unique_active_child_per_parent" ON "public"."anchors" USING "btree" ("parent_anchor_id") WHERE (("parent_anchor_id" IS NOT NULL) AND ("deleted_at" IS NULL) AND ("status" <> 'REVOKED'::"public"."anchor_status"));



COMMENT ON INDEX "public"."anchors_unique_active_child_per_parent" IS 'ARK-104 hardening (migration 0233): at most one non-revoked, non-deleted child per parent anchor. Enforces lineage is a chain, not a tree, even if application-level locks fail.';



CREATE INDEX "idx_adobe_sign_webhook_nonces_received_at" ON "public"."adobe_sign_webhook_nonces" USING "btree" ("received_at");



CREATE INDEX "idx_agents_org_id" ON "public"."agents" USING "btree" ("org_id");



CREATE INDEX "idx_agents_status" ON "public"."agents" USING "btree" ("status") WHERE ("status" = 'active'::"public"."agent_status");



CREATE INDEX "idx_agents_type" ON "public"."agents" USING "btree" ("agent_type");



CREATE INDEX "idx_ai_credits_org" ON "public"."ai_credits" USING "btree" ("org_id") WHERE ("org_id" IS NOT NULL);



CREATE INDEX "idx_ai_credits_period" ON "public"."ai_credits" USING "btree" ("period_start", "period_end");



CREATE INDEX "idx_ai_credits_user" ON "public"."ai_credits" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "idx_ai_reports_org_created" ON "public"."ai_reports" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_ai_reports_org_status" ON "public"."ai_reports" USING "btree" ("org_id", "status", "created_at" DESC);



CREATE INDEX "idx_ai_usage_events_cache_lookup" ON "public"."ai_usage_events" USING "btree" ("fingerprint", "event_type", "success") WHERE ("result_json" IS NOT NULL);



CREATE INDEX "idx_ai_usage_events_org" ON "public"."ai_usage_events" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_ai_usage_events_org_created" ON "public"."ai_usage_events" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_ai_usage_events_type" ON "public"."ai_usage_events" USING "btree" ("event_type", "created_at" DESC);



CREATE INDEX "idx_ai_usage_events_user" ON "public"."ai_usage_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_anchor_proofs_anchor_id" ON "public"."anchor_proofs" USING "btree" ("anchor_id");



CREATE INDEX "idx_anchor_proofs_batch_id" ON "public"."anchor_proofs" USING "btree" ("batch_id") WHERE ("batch_id" IS NOT NULL);



CREATE INDEX "idx_anchor_proofs_receipt_id" ON "public"."anchor_proofs" USING "btree" ("receipt_id");



CREATE UNIQUE INDEX "idx_anchor_queue_resolutions_idempotency" ON "public"."anchor_queue_resolutions" USING "btree" ("org_id", "external_file_id", "selected_anchor_id");



CREATE INDEX "idx_anchor_queue_resolutions_org_created" ON "public"."anchor_queue_resolutions" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_anchor_recipients_email_hash" ON "public"."anchor_recipients" USING "btree" ("recipient_email_hash");



CREATE INDEX "idx_anchor_recipients_user_id" ON "public"."anchor_recipients" USING "btree" ("recipient_user_id") WHERE ("recipient_user_id" IS NOT NULL);



CREATE INDEX "idx_anchors_active_created" ON "public"."anchors" USING "btree" ("created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_backfill_desc" ON "public"."anchors" USING "btree" ((("metadata" ->> 'pipeline_source'::"text")), (("metadata" ->> 'source_id'::"text"))) WHERE (("description" IS NULL) AND (("metadata" ->> 'pipeline_source'::"text") IS NOT NULL));



CREATE INDEX "idx_anchors_broadcasting_status" ON "public"."anchors" USING "btree" ("status", "updated_at") WHERE ("status" = 'BROADCASTING'::"public"."anchor_status");



CREATE INDEX "idx_anchors_chain_tx_id" ON "public"."anchors" USING "btree" ("chain_tx_id") WHERE (("deleted_at" IS NULL) AND ("chain_tx_id" IS NOT NULL));



CREATE INDEX "idx_anchors_created_at" ON "public"."anchors" USING "btree" ("created_at");



CREATE INDEX "idx_anchors_credential_type_btree" ON "public"."anchors" USING "btree" ("credential_type");



CREATE INDEX "idx_anchors_credential_type_status" ON "public"."anchors" USING "btree" ("credential_type", "status") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_desc_backfill" ON "public"."anchors" USING "btree" ("id") WHERE ((("metadata" ->> 'pipeline_source'::"text") IS NOT NULL) AND ("description" IS NULL));



CREATE INDEX "idx_anchors_description_trgm" ON "public"."anchors" USING "gin" ("description" "public"."gin_trgm_ops");



CREATE INDEX "idx_anchors_filename_trgm" ON "public"."anchors" USING "gin" ("filename" "public"."gin_trgm_ops") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_fingerprint_lookup" ON "public"."anchors" USING "btree" ("fingerprint") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_org_deleted_created" ON "public"."anchors" USING "btree" ("org_id", "created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_org_nopipeline_created" ON "public"."anchors" USING "btree" ("org_id", "created_at" DESC) WHERE (("deleted_at" IS NULL) AND (("metadata" ->> 'pipeline_source'::"text") IS NULL));



CREATE INDEX "idx_anchors_org_status_created" ON "public"."anchors" USING "btree" ("org_id", "status", "created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_parent_anchor_id" ON "public"."anchors" USING "btree" ("parent_anchor_id") WHERE ("parent_anchor_id" IS NOT NULL);



CREATE INDEX "idx_anchors_pending_claim" ON "public"."anchors" USING "btree" ("created_at") WHERE (("status" = 'PENDING'::"public"."anchor_status") AND ("deleted_at" IS NULL));



CREATE INDEX "idx_anchors_status" ON "public"."anchors" USING "btree" ("status");



CREATE INDEX "idx_anchors_status_created" ON "public"."anchors" USING "btree" ("status", "created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_status_non_secured" ON "public"."anchors" USING "btree" ("status") WHERE (("status" <> 'SECURED'::"public"."anchor_status") AND ("deleted_at" IS NULL));



CREATE INDEX "idx_anchors_status_secured_submitted" ON "public"."anchors" USING "btree" ("created_at" DESC) WHERE (("status" = ANY (ARRAY['SECURED'::"public"."anchor_status", 'SUBMITTED'::"public"."anchor_status"])) AND ("deleted_at" IS NULL));



CREATE INDEX "idx_anchors_sub_type" ON "public"."anchors" USING "btree" ("sub_type") WHERE ("sub_type" IS NOT NULL);



CREATE INDEX "idx_anchors_submitted_chain_tx" ON "public"."anchors" USING "btree" ("chain_tx_id") WHERE (("status" = 'SUBMITTED'::"public"."anchor_status") AND ("deleted_at" IS NULL));



CREATE INDEX "idx_anchors_submitted_status" ON "public"."anchors" USING "btree" ("status") WHERE ("status" = 'SUBMITTED'::"public"."anchor_status");



CREATE INDEX "idx_anchors_user_created" ON "public"."anchors" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_anchors_user_created_desc" ON "public"."anchors" USING "btree" ("user_id", "created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE UNIQUE INDEX "idx_anchors_user_fingerprint_unique" ON "public"."anchors" USING "btree" ("user_id", "fingerprint") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_anchors_user_id" ON "public"."anchors" USING "btree" ("user_id");



CREATE INDEX "idx_anchors_user_nopipeline_created" ON "public"."anchors" USING "btree" ("user_id", "created_at" DESC) WHERE (("deleted_at" IS NULL) AND (("metadata" ->> 'pipeline_source'::"text") IS NULL));



CREATE INDEX "idx_anchors_user_status_created" ON "public"."anchors" USING "btree" ("user_id", "status", "created_at" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_api_key_usage_org_month" ON "public"."api_key_usage" USING "btree" ("org_id", "month");



CREATE INDEX "idx_api_keys_active" ON "public"."api_keys" USING "btree" ("org_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_api_keys_agent_id" ON "public"."api_keys" USING "btree" ("agent_id") WHERE ("agent_id" IS NOT NULL);



CREATE INDEX "idx_api_keys_key_hash" ON "public"."api_keys" USING "btree" ("key_hash");



CREATE INDEX "idx_api_keys_org_id" ON "public"."api_keys" USING "btree" ("org_id");



CREATE INDEX "idx_api_keys_scopes" ON "public"."api_keys" USING "gin" ("scopes");



CREATE INDEX "idx_ats_integrations_org_id" ON "public"."ats_integrations" USING "btree" ("org_id");



CREATE INDEX "idx_ats_webhook_nonces_received_at" ON "public"."ats_webhook_nonces" USING "btree" ("received_at");



CREATE UNIQUE INDEX "idx_attestation_evidence_public_id" ON "public"."attestation_evidence" USING "btree" ("public_id");



CREATE INDEX "idx_attestations_anchor_id" ON "public"."attestations" USING "btree" ("anchor_id") WHERE ("anchor_id" IS NOT NULL);



CREATE INDEX "idx_attestations_attester_org" ON "public"."attestations" USING "btree" ("attester_org_id") WHERE ("attester_org_id" IS NOT NULL);



CREATE INDEX "idx_attestations_attester_user" ON "public"."attestations" USING "btree" ("attester_user_id");



CREATE INDEX "idx_attestations_created" ON "public"."attestations" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_attestations_public_id" ON "public"."attestations" USING "btree" ("public_id");



CREATE INDEX "idx_attestations_status" ON "public"."attestations" USING "btree" ("status");



CREATE INDEX "idx_attestations_subject" ON "public"."attestations" USING "btree" ("subject_identifier");



CREATE INDEX "idx_attestations_type" ON "public"."attestations" USING "btree" ("attestation_type");



CREATE INDEX "idx_audit_events_actor_id" ON "public"."audit_events" USING "btree" ("actor_id") WHERE ("actor_id" IS NOT NULL);



CREATE INDEX "idx_audit_events_created_at" ON "public"."audit_events" USING "btree" ("created_at");



CREATE INDEX "idx_audit_events_event_type" ON "public"."audit_events" USING "btree" ("event_type");



CREATE INDEX "idx_audit_events_org_id" ON "public"."audit_events" USING "btree" ("org_id") WHERE ("org_id" IS NOT NULL);



CREATE INDEX "idx_audit_events_target" ON "public"."audit_events" USING "btree" ("target_type", "target_id") WHERE ("target_id" IS NOT NULL);



COMMENT ON INDEX "public"."idx_audit_events_target" IS 'SCRUM-896 / SCRUM-1173: required by GET /anchor/{publicId}/lifecycle and GET /anchor/{publicId}/evidence. Restored after migration 0214 dropped it. Idempotent across PRs #570 and #573.';



CREATE INDEX "idx_batch_jobs_api_key" ON "public"."batch_verification_jobs" USING "btree" ("api_key_id");



CREATE INDEX "idx_batch_jobs_created_at" ON "public"."batch_verification_jobs" USING "btree" ("created_at");



CREATE INDEX "idx_billing_events_event_type" ON "public"."billing_events" USING "btree" ("event_type");



CREATE INDEX "idx_billing_events_processed_at" ON "public"."billing_events" USING "btree" ("processed_at");



CREATE INDEX "idx_billing_events_stripe_event_id" ON "public"."billing_events" USING "btree" ("stripe_event_id");



CREATE INDEX "idx_billing_events_user_id" ON "public"."billing_events" USING "btree" ("user_id");



CREATE INDEX "idx_brin_audit_events_created" ON "public"."audit_events" USING "brin" ("created_at");



CREATE INDEX "idx_brin_credit_transactions_created" ON "public"."credit_transactions" USING "brin" ("created_at");



CREATE INDEX "idx_brin_job_queue_created" ON "public"."job_queue" USING "brin" ("created_at");



CREATE INDEX "idx_checkr_webhook_nonces_received_at" ON "public"."checkr_webhook_nonces" USING "btree" ("received_at");



CREATE INDEX "idx_cloud_logging_queue_drain_order" ON "public"."cloud_logging_queue" USING "btree" ("enqueued_at") WHERE ("retry_count" < 10);



CREATE INDEX "idx_compliance_audits_org_recent" ON "public"."compliance_audits" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_compliance_audits_status" ON "public"."compliance_audits" USING "btree" ("org_id", "status", "created_at" DESC) WHERE ("status" = ANY (ARRAY['QUEUED'::"text", 'RUNNING'::"text"]));



CREATE INDEX "idx_compliance_scores_history" ON "public"."compliance_scores" USING "btree" ("org_id", "last_calculated" DESC);



CREATE INDEX "idx_compliance_scores_org_lookup" ON "public"."compliance_scores" USING "btree" ("org_id", "jurisdiction_code", "industry_code");



CREATE INDEX "idx_connector_subscriptions_expires_at" ON "public"."connector_subscriptions" USING "btree" ("expires_at") WHERE ("status" = ANY (ARRAY['active'::"text", 'degraded'::"text"]));



CREATE INDEX "idx_connector_subscriptions_org_provider" ON "public"."connector_subscriptions" USING "btree" ("org_id", "provider");



CREATE INDEX "idx_credential_embeddings_anchor" ON "public"."credential_embeddings" USING "btree" ("anchor_id");



CREATE INDEX "idx_credential_embeddings_hnsw" ON "public"."credential_embeddings" USING "hnsw" ("embedding" "public"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "idx_credential_embeddings_org" ON "public"."credential_embeddings" USING "btree" ("org_id");



CREATE INDEX "idx_credential_portfolios_public_id" ON "public"."credential_portfolios" USING "btree" ("public_id");



CREATE INDEX "idx_credential_portfolios_user_id" ON "public"."credential_portfolios" USING "btree" ("user_id");



CREATE INDEX "idx_credential_templates_credential_type" ON "public"."credential_templates" USING "btree" ("credential_type");



CREATE INDEX "idx_credential_templates_org_id" ON "public"."credential_templates" USING "btree" ("org_id");



CREATE UNIQUE INDEX "idx_credential_templates_org_unique" ON "public"."credential_templates" USING "btree" ("org_id", "name") WHERE (("is_system" = false) AND ("org_id" IS NOT NULL));



CREATE UNIQUE INDEX "idx_credential_templates_system_unique" ON "public"."credential_templates" USING "btree" ("name") WHERE ("is_system" = true);



CREATE INDEX "idx_credit_transactions_user_created" ON "public"."credit_transactions" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_credits_user" ON "public"."credits" USING "btree" ("user_id");



CREATE INDEX "idx_data_subject_requests_export_recent" ON "public"."data_subject_requests" USING "btree" ("user_id", "completed_at" DESC) WHERE (("request_type" = 'export'::"text") AND ("status" = 'completed'::"text"));



CREATE INDEX "idx_data_subject_requests_requested_at" ON "public"."data_subject_requests" USING "btree" ("requested_at" DESC);



CREATE INDEX "idx_data_subject_requests_type" ON "public"."data_subject_requests" USING "btree" ("request_type");



CREATE INDEX "idx_data_subject_requests_user_id" ON "public"."data_subject_requests" USING "btree" ("user_id");



CREATE INDEX "idx_docusign_webhook_nonces_received_at" ON "public"."docusign_webhook_nonces" USING "btree" ("received_at");



CREATE INDEX "idx_drive_folder_path_cache_cached_at" ON "public"."drive_folder_path_cache" USING "btree" ("cached_at");



CREATE INDEX "idx_drive_revision_ledger_integration_processed" ON "public"."drive_revision_ledger" USING "btree" ("integration_id", "processed_at" DESC);



CREATE INDEX "idx_drive_revision_ledger_org_processed" ON "public"."drive_revision_ledger" USING "btree" ("org_id", "processed_at" DESC);



CREATE INDEX "idx_drive_webhook_nonces_received_at" ON "public"."drive_webhook_nonces" USING "btree" ("received_at");



CREATE INDEX "idx_emergency_access_active" ON "public"."emergency_access_grants" USING "btree" ("expires_at") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_emergency_access_grantee" ON "public"."emergency_access_grants" USING "btree" ("grantee_id");



CREATE INDEX "idx_emergency_access_org" ON "public"."emergency_access_grants" USING "btree" ("org_id");



CREATE INDEX "idx_entitlements_org_id" ON "public"."entitlements" USING "btree" ("org_id") WHERE ("org_id" IS NOT NULL);



CREATE INDEX "idx_entitlements_type" ON "public"."entitlements" USING "btree" ("entitlement_type");



CREATE INDEX "idx_entitlements_user_id" ON "public"."entitlements" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "idx_evidence_attestation" ON "public"."attestation_evidence" USING "btree" ("attestation_id");



CREATE INDEX "idx_extraction_feedback_anchor" ON "public"."extraction_feedback" USING "btree" ("anchor_id");



CREATE INDEX "idx_extraction_feedback_org" ON "public"."extraction_feedback" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_extraction_feedback_type_field" ON "public"."extraction_feedback" USING "btree" ("credential_type", "field_key");



CREATE INDEX "idx_extraction_manifests_anchor_id" ON "public"."extraction_manifests" USING "btree" ("anchor_id");



CREATE INDEX "idx_extraction_manifests_created_at" ON "public"."extraction_manifests" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_extraction_manifests_fingerprint" ON "public"."extraction_manifests" USING "btree" ("fingerprint");



CREATE INDEX "idx_extraction_manifests_manifest_hash" ON "public"."extraction_manifests" USING "btree" ("manifest_hash");



CREATE INDEX "idx_extraction_manifests_org_id" ON "public"."extraction_manifests" USING "btree" ("org_id");



CREATE INDEX "idx_extraction_manifests_poseidon_hash" ON "public"."extraction_manifests" USING "btree" ("zk_poseidon_hash") WHERE ("zk_poseidon_hash" IS NOT NULL);



CREATE INDEX "idx_extraction_manifests_zk_proof_status" ON "public"."extraction_manifests" USING "btree" ((("zk_proof" IS NOT NULL)));



CREATE INDEX "idx_ferpa_disclosure_date" ON "public"."ferpa_disclosure_log" USING "btree" ("disclosed_at");



CREATE INDEX "idx_ferpa_disclosure_exception" ON "public"."ferpa_disclosure_log" USING "btree" ("disclosure_exception");



CREATE INDEX "idx_ferpa_disclosure_org" ON "public"."ferpa_disclosure_log" USING "btree" ("org_id");



CREATE INDEX "idx_ferpa_disclosure_party_type" ON "public"."ferpa_disclosure_log" USING "btree" ("requesting_party_type");



CREATE INDEX "idx_ferpa_disclosure_records" ON "public"."ferpa_disclosure_log" USING "gin" ("education_record_ids");



CREATE UNIQUE INDEX "idx_financial_reports_month" ON "public"."financial_reports" USING "btree" ("report_month");



CREATE INDEX "idx_grc_connections_active" ON "public"."grc_connections" USING "btree" ("is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_grc_connections_org" ON "public"."grc_connections" USING "btree" ("org_id");



CREATE INDEX "idx_grc_sync_logs_anchor" ON "public"."grc_sync_logs" USING "btree" ("anchor_id") WHERE ("anchor_id" IS NOT NULL);



CREATE INDEX "idx_grc_sync_logs_connection" ON "public"."grc_sync_logs" USING "btree" ("connection_id");



CREATE INDEX "idx_grc_sync_logs_created" ON "public"."grc_sync_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_institution_ground_truth_domain" ON "public"."institution_ground_truth" USING "btree" ("domain") WHERE ("domain" IS NOT NULL);



CREATE INDEX "idx_institution_ground_truth_name_trgm" ON "public"."institution_ground_truth" USING "gin" ("institution_name" "public"."gin_trgm_ops");



CREATE INDEX "idx_institution_ground_truth_source" ON "public"."institution_ground_truth" USING "btree" ("source");



CREATE INDEX "idx_integration_events_org_id_created" ON "public"."integration_events" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_integrity_scores_anchor" ON "public"."integrity_scores" USING "btree" ("anchor_id");



CREATE INDEX "idx_integrity_scores_org_level" ON "public"."integrity_scores" USING "btree" ("org_id", "level");



CREATE INDEX "idx_job_queue_claim" ON "public"."job_queue" USING "btree" ("type", "status", "priority" DESC, "created_at") WHERE ("status" = ANY (ARRAY['pending'::"text", 'failed'::"text"]));



CREATE INDEX "idx_job_queue_status" ON "public"."job_queue" USING "btree" ("status") WHERE ("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'failed'::"text"]));



CREATE INDEX "idx_jurisdiction_rules_lookup" ON "public"."jurisdiction_rules" USING "btree" ("jurisdiction_code", "industry_code");



CREATE INDEX "idx_kyb_events_org_id_created" ON "public"."kyb_events" USING "btree" ("org_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_kyb_events_provider_event_id_unique" ON "public"."kyb_events" USING "btree" ("provider", "provider_event_id") WHERE ("provider_event_id" IS NOT NULL);



CREATE INDEX "idx_kyb_webhook_nonces_received_at" ON "public"."kyb_webhook_nonces" USING "btree" ("received_at");



CREATE INDEX "idx_memberships_org_id" ON "public"."memberships" USING "btree" ("org_id");



CREATE INDEX "idx_memberships_user_id" ON "public"."memberships" USING "btree" ("user_id");



CREATE INDEX "idx_notifications_created" ON "public"."user_notifications" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_notifications_org" ON "public"."user_notifications" USING "btree" ("organization_id");



CREATE INDEX "idx_notifications_org_recent" ON "public"."notifications" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_notifications_org_unread" ON "public"."notifications" USING "btree" ("org_id", "created_at" DESC) WHERE ("read_at" IS NULL);



CREATE INDEX "idx_notifications_user_read" ON "public"."user_notifications" USING "btree" ("user_id", "read_at");



CREATE INDEX "idx_org_credit_allocations_child" ON "public"."org_credit_allocations" USING "btree" ("child_org_id", "effective_at" DESC);



CREATE INDEX "idx_org_credit_allocations_parent" ON "public"."org_credit_allocations" USING "btree" ("parent_org_id", "effective_at" DESC);



CREATE INDEX "idx_org_integrations_org_provider_active" ON "public"."org_integrations" USING "btree" ("org_id", "provider") WHERE ("revoked_at" IS NULL);



CREATE UNIQUE INDEX "idx_org_integrations_org_provider_active_null_account" ON "public"."org_integrations" USING "btree" ("org_id", "provider") WHERE (("revoked_at" IS NULL) AND ("account_id" IS NULL));



COMMENT ON INDEX "public"."idx_org_integrations_org_provider_active_null_account" IS 'SCRUM-1241 / AUDIT-0424-17: enforces one active integration per (org_id, provider) when account_id is null. Defense-in-depth atop the base UNIQUE (org_id, provider, account_id) which permits multiple null-account_id rows because Postgres treats NULLs as distinct.';



CREATE INDEX "idx_org_integrations_subscription_renewal_due" ON "public"."org_integrations" USING "btree" ("subscription_expires_at") WHERE (("revoked_at" IS NULL) AND ("subscription_expires_at" IS NOT NULL));



CREATE INDEX "idx_org_members_org_id" ON "public"."org_members" USING "btree" ("org_id");



CREATE INDEX "idx_org_members_user_id" ON "public"."org_members" USING "btree" ("user_id");



CREATE INDEX "idx_org_monthly_allocation_org_period" ON "public"."org_monthly_allocation" USING "btree" ("org_id", "period_start" DESC);



CREATE INDEX "idx_organization_rule_events_external_file" ON "public"."organization_rule_events" USING "btree" ("org_id", "external_file_id", "created_at" DESC) WHERE ("external_file_id" IS NOT NULL);



CREATE INDEX "idx_organization_rule_events_org_trigger_created" ON "public"."organization_rule_events" USING "btree" ("org_id", "trigger_type", "created_at" DESC);



CREATE INDEX "idx_organization_rule_events_pending" ON "public"."organization_rule_events" USING "btree" ("status", "created_at") WHERE ("status" = ANY (ARRAY['PENDING'::"public"."org_rule_event_status", 'CLAIMED'::"public"."org_rule_event_status"]));



CREATE INDEX "idx_organization_rule_executions_dlq" ON "public"."organization_rule_executions" USING "btree" ("org_id", "created_at" DESC) WHERE ("status" = 'DLQ'::"public"."org_rule_execution_status");



CREATE UNIQUE INDEX "idx_organization_rule_executions_idempotency" ON "public"."organization_rule_executions" USING "btree" ("rule_id", "trigger_event_id");



CREATE INDEX "idx_organization_rule_executions_org_status_created" ON "public"."organization_rule_executions" USING "btree" ("org_id", "status", "created_at" DESC);



CREATE INDEX "idx_organization_rule_executions_rule_created" ON "public"."organization_rule_executions" USING "btree" ("rule_id", "created_at" DESC);



CREATE INDEX "idx_organization_rules_last_executed" ON "public"."organization_rules" USING "btree" ("last_executed_at" DESC NULLS LAST) WHERE ("enabled" = true);



CREATE INDEX "idx_organization_rules_org_enabled" ON "public"."organization_rules" USING "btree" ("org_id", "enabled") WHERE ("enabled" = true);



CREATE INDEX "idx_organization_rules_org_trigger" ON "public"."organization_rules" USING "btree" ("org_id", "trigger_type");



CREATE INDEX "idx_organizations_created_at" ON "public"."organizations" USING "btree" ("created_at");



CREATE INDEX "idx_organizations_domain" ON "public"."organizations" USING "btree" ("domain") WHERE ("domain" IS NOT NULL);



CREATE INDEX "idx_organizations_domain_verified" ON "public"."organizations" USING "btree" ("domain") WHERE ("domain_verified" = true);



CREATE INDEX "idx_organizations_ein" ON "public"."organizations" USING "btree" ("ein_tax_id") WHERE ("ein_tax_id" IS NOT NULL);



CREATE INDEX "idx_organizations_kyb_reference_id" ON "public"."organizations" USING "btree" ("kyb_reference_id") WHERE ("kyb_reference_id" IS NOT NULL);



CREATE UNIQUE INDEX "idx_organizations_org_prefix" ON "public"."organizations" USING "btree" ("org_prefix") WHERE ("org_prefix" IS NOT NULL);



CREATE INDEX "idx_organizations_parent" ON "public"."organizations" USING "btree" ("parent_org_id") WHERE ("parent_org_id" IS NOT NULL);



CREATE INDEX "idx_organizations_payment_grace_expires" ON "public"."organizations" USING "btree" ("payment_grace_expires_at") WHERE ("payment_grace_expires_at" IS NOT NULL);



CREATE INDEX "idx_organizations_public_id" ON "public"."organizations" USING "btree" ("public_id") WHERE ("public_id" IS NOT NULL);



CREATE INDEX "idx_organizations_suspended" ON "public"."organizations" USING "btree" ("suspended") WHERE ("suspended" = true);



CREATE INDEX "idx_parent_split_tokens_sub_org" ON "public"."parent_split_tokens" USING "btree" ("sub_org_id") WHERE ("consumed_at" IS NULL);



CREATE INDEX "idx_pre_record_id" ON "public"."public_record_embeddings" USING "btree" ("public_record_id");



CREATE INDEX "idx_profiles_activation_token" ON "public"."profiles" USING "btree" ("activation_token") WHERE ("activation_token" IS NOT NULL);



CREATE INDEX "idx_profiles_deleted_at" ON "public"."profiles" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "idx_profiles_disclaimer_accepted" ON "public"."profiles" USING "btree" ("disclaimer_accepted_at") WHERE ("disclaimer_accepted_at" IS NOT NULL);



CREATE UNIQUE INDEX "idx_profiles_email" ON "public"."profiles" USING "btree" ("email");



CREATE INDEX "idx_profiles_id_role_org" ON "public"."profiles" USING "btree" ("id", "role", "org_id");



CREATE INDEX "idx_profiles_identity_verification_status" ON "public"."profiles" USING "btree" ("identity_verification_status") WHERE ("identity_verification_status" <> 'unstarted'::"text");



CREATE INDEX "idx_profiles_org_id" ON "public"."profiles" USING "btree" ("org_id") WHERE ("org_id" IS NOT NULL);



CREATE INDEX "idx_profiles_platform_admin" ON "public"."profiles" USING "btree" ("is_platform_admin") WHERE ("is_platform_admin" = true);



CREATE INDEX "idx_profiles_public_id" ON "public"."profiles" USING "btree" ("public_id") WHERE ("public_id" IS NOT NULL);



CREATE INDEX "idx_profiles_requires_review" ON "public"."profiles" USING "btree" ("requires_manual_review") WHERE ("requires_manual_review" = true);



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role") WHERE ("role" IS NOT NULL);



CREATE INDEX "idx_public_records_anchor_id" ON "public"."public_records" USING "btree" ("anchor_id");



CREATE INDEX "idx_public_records_created_at" ON "public"."public_records" USING "btree" ("created_at");



CREATE INDEX "idx_public_records_record_type" ON "public"."public_records" USING "btree" ("record_type");



CREATE INDEX "idx_public_records_source" ON "public"."public_records" USING "btree" ("source");



CREATE INDEX "idx_public_records_source_created" ON "public"."public_records" USING "btree" ("source", "created_at" DESC);



CREATE UNIQUE INDEX "idx_public_records_source_unique" ON "public"."public_records" USING "btree" ("source", "source_id");



CREATE INDEX "idx_public_records_type_created" ON "public"."public_records" USING "btree" ("record_type", "created_at" DESC);



CREATE INDEX "idx_public_records_unanchored" ON "public"."public_records" USING "btree" ("created_at") WHERE ("anchor_id" IS NULL);



CREATE UNIQUE INDEX "idx_reconciliation_reports_month_type" ON "public"."reconciliation_reports" USING "btree" ("report_month", "report_type");



CREATE INDEX "idx_report_artifacts_report_id" ON "public"."report_artifacts" USING "btree" ("report_id");



CREATE INDEX "idx_reports_created_at" ON "public"."reports" USING "btree" ("created_at");



CREATE INDEX "idx_reports_org_id" ON "public"."reports" USING "btree" ("org_id") WHERE ("org_id" IS NOT NULL);



CREATE INDEX "idx_reports_status" ON "public"."reports" USING "btree" ("status");



CREATE INDEX "idx_reports_user_id" ON "public"."reports" USING "btree" ("user_id");



CREATE INDEX "idx_review_queue_anchor" ON "public"."review_queue_items" USING "btree" ("anchor_id");



CREATE INDEX "idx_review_queue_org_status" ON "public"."review_queue_items" USING "btree" ("org_id", "status", "priority" DESC);



CREATE INDEX "idx_review_queue_status" ON "public"."review_queue_items" USING "btree" ("status", "created_at" DESC) WHERE ("status" = 'PENDING'::"public"."review_status");



CREATE INDEX "idx_rule_embeddings_last_used" ON "public"."rule_embeddings" USING "btree" ("last_used_at" DESC);



CREATE INDEX "idx_signatures_anchor_id" ON "public"."signatures" USING "btree" ("anchor_id");



CREATE INDEX "idx_signatures_attestation_id" ON "public"."signatures" USING "btree" ("attestation_id");



CREATE INDEX "idx_signatures_created_at" ON "public"."signatures" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_signatures_org_id" ON "public"."signatures" USING "btree" ("org_id");



CREATE INDEX "idx_signatures_public_id" ON "public"."signatures" USING "btree" ("public_id");



CREATE INDEX "idx_signatures_signer_cert" ON "public"."signatures" USING "btree" ("signer_certificate_id");



CREATE INDEX "idx_signatures_status" ON "public"."signatures" USING "btree" ("status");



CREATE INDEX "idx_signing_certs_not_after" ON "public"."signing_certificates" USING "btree" ("not_after");



CREATE INDEX "idx_signing_certs_org" ON "public"."signing_certificates" USING "btree" ("org_id");



CREATE INDEX "idx_signing_certs_status" ON "public"."signing_certificates" USING "btree" ("status");



CREATE INDEX "idx_subscriptions_status" ON "public"."subscriptions" USING "btree" ("status");



CREATE INDEX "idx_subscriptions_stripe_subscription_id" ON "public"."subscriptions" USING "btree" ("stripe_subscription_id");



CREATE INDEX "idx_subscriptions_user_id" ON "public"."subscriptions" USING "btree" ("user_id");



CREATE INDEX "idx_subscriptions_user_status" ON "public"."subscriptions" USING "btree" ("user_id", "status") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_tst_gen_time" ON "public"."timestamp_tokens" USING "btree" ("tst_gen_time" DESC);



CREATE INDEX "idx_tst_org" ON "public"."timestamp_tokens" USING "btree" ("org_id");



CREATE INDEX "idx_tst_provider" ON "public"."timestamp_tokens" USING "btree" ("tsa_name");



CREATE INDEX "idx_tst_signature" ON "public"."timestamp_tokens" USING "btree" ("signature_id");



CREATE INDEX "idx_verification_events_anchor" ON "public"."verification_events" USING "btree" ("anchor_id", "created_at" DESC);



CREATE INDEX "idx_verification_events_created_at" ON "public"."verification_events" USING "btree" ("created_at");



CREATE INDEX "idx_verification_events_method" ON "public"."verification_events" USING "btree" ("method");



CREATE INDEX "idx_verification_events_org_id" ON "public"."verification_events" USING "btree" ("org_id") WHERE ("org_id" IS NOT NULL);



CREATE INDEX "idx_verification_events_public_id" ON "public"."verification_events" USING "btree" ("public_id");



CREATE INDEX "idx_webhook_delivery_logs_endpoint" ON "public"."webhook_delivery_logs" USING "btree" ("endpoint_id", "created_at" DESC);



CREATE INDEX "idx_webhook_delivery_logs_endpoint_id" ON "public"."webhook_delivery_logs" USING "btree" ("endpoint_id");



CREATE INDEX "idx_webhook_delivery_logs_event_id" ON "public"."webhook_delivery_logs" USING "btree" ("event_id");



CREATE INDEX "idx_webhook_delivery_logs_retry" ON "public"."webhook_delivery_logs" USING "btree" ("status", "next_retry_at") WHERE (("status" = 'retrying'::"text") AND ("next_retry_at" IS NOT NULL));



CREATE INDEX "idx_webhook_delivery_logs_status" ON "public"."webhook_delivery_logs" USING "btree" ("status");



CREATE INDEX "idx_webhook_dlq_external_id" ON "public"."webhook_dlq" USING "btree" ("provider", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "idx_webhook_dlq_org_resolved" ON "public"."webhook_dead_letter_queue" USING "btree" ("org_id", "resolved", "failed_at" DESC);



CREATE INDEX "idx_webhook_dlq_provider_unresolved" ON "public"."webhook_dlq" USING "btree" ("provider", "created_at" DESC) WHERE ("resolved_at" IS NULL);



CREATE INDEX "idx_webhook_endpoints_active" ON "public"."webhook_endpoints" USING "btree" ("org_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_webhook_endpoints_org_id" ON "public"."webhook_endpoints" USING "btree" ("org_id");



CREATE INDEX "idx_x402_payments_created" ON "public"."x402_payments" USING "btree" ("created_at");



CREATE INDEX "idx_x402_payments_org_verified" ON "public"."x402_payments" USING "btree" ("org_id", "verified", "created_at" DESC);



CREATE INDEX "idx_x402_payments_payer" ON "public"."x402_payments" USING "btree" ("payer_address");



CREATE INDEX "idx_x402_payments_tx_hash" ON "public"."x402_payments" USING "btree" ("tx_hash");



CREATE UNIQUE INDEX "idx_x402_payments_tx_hash_unique" ON "public"."x402_payments" USING "btree" ("tx_hash") WHERE (("tx_hash" IS NOT NULL) AND ("tx_hash" <> ''::"text"));



CREATE UNIQUE INDEX "mv_anchor_status_counts_status_idx" ON "public"."mv_anchor_status_counts" USING "btree" ("status");



CREATE UNIQUE INDEX "mv_public_records_source_counts_source_idx" ON "public"."mv_public_records_source_counts" USING "btree" ("source");



CREATE UNIQUE INDEX "webhook_delivery_logs_public_id_uidx" ON "public"."webhook_delivery_logs" USING "btree" ("public_id");



CREATE UNIQUE INDEX "webhook_endpoints_public_id_uidx" ON "public"."webhook_endpoints" USING "btree" ("public_id");



CREATE OR REPLACE TRIGGER "agents_updated_at" BEFORE UPDATE ON "public"."agents" FOR EACH ROW EXECUTE FUNCTION "public"."update_agents_updated_at"();



CREATE OR REPLACE TRIGGER "attestations_immutable_claims" BEFORE UPDATE ON "public"."attestations" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_attestation_claim_modification"();



CREATE OR REPLACE TRIGGER "attestations_updated_at" BEFORE UPDATE ON "public"."attestations" FOR EACH ROW EXECUTE FUNCTION "public"."update_attestation_updated_at"();



CREATE OR REPLACE TRIGGER "audit_events_to_cloud_logging_queue" AFTER INSERT ON "public"."audit_events" FOR EACH ROW EXECUTE FUNCTION "public"."enqueue_audit_for_cloud_logging"();



COMMENT ON TRIGGER "audit_events_to_cloud_logging_queue" ON "public"."audit_events" IS 'GCP-MAX-03: enqueue each new audit_events row for the Cloud Logging drain cron.';



CREATE OR REPLACE TRIGGER "auto_org_prefix_on_insert" BEFORE INSERT ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."auto_generate_org_prefix"();



CREATE OR REPLACE TRIGGER "enforce_org_parent_depth_trg" BEFORE INSERT OR UPDATE OF "parent_org_id" ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_org_parent_depth"();



CREATE OR REPLACE TRIGGER "enforce_profiles_lowercase_email" BEFORE INSERT OR UPDATE OF "email" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_lowercase_email"();



CREATE OR REPLACE TRIGGER "enforce_role_immutability" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."check_role_immutability"();



CREATE OR REPLACE TRIGGER "generate_org_public_id_on_insert" BEFORE INSERT ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."auto_generate_org_public_id"();



CREATE OR REPLACE TRIGGER "generate_profile_public_id_on_insert" BEFORE INSERT ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."auto_generate_profile_public_id"();



CREATE OR REPLACE TRIGGER "generate_public_id_on_insert" BEFORE INSERT ON "public"."anchors" FOR EACH ROW EXECUTE FUNCTION "public"."auto_generate_public_id"();



CREATE OR REPLACE TRIGGER "grc_connections_updated_at" BEFORE UPDATE ON "public"."grc_connections" FOR EACH ROW EXECUTE FUNCTION "public"."update_grc_connections_updated_at"();



CREATE OR REPLACE TRIGGER "org_integrations_updated_at" BEFORE UPDATE ON "public"."org_integrations" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "org_monthly_allocation_updated_at" BEFORE UPDATE ON "public"."org_monthly_allocation" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "org_tier_entitlements_updated_at" BEFORE UPDATE ON "public"."org_tier_entitlements" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "plans_updated_at" BEFORE UPDATE ON "public"."plans" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "protect_anchor_fields" BEFORE UPDATE ON "public"."anchors" FOR EACH ROW EXECUTE FUNCTION "public"."protect_anchor_status_transition"();



CREATE OR REPLACE TRIGGER "protect_privileged_fields" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_privileged_profile_fields"();



CREATE OR REPLACE TRIGGER "reject_audit_delete" BEFORE DELETE ON "public"."audit_events" FOR EACH ROW EXECUTE FUNCTION "public"."reject_audit_modification"();



CREATE OR REPLACE TRIGGER "reject_audit_update" BEFORE UPDATE ON "public"."audit_events" FOR EACH ROW EXECUTE FUNCTION "public"."reject_audit_modification"();



CREATE OR REPLACE TRIGGER "reject_billing_events_delete" BEFORE DELETE ON "public"."billing_events" FOR EACH ROW EXECUTE FUNCTION "public"."reject_audit_modification"();



CREATE OR REPLACE TRIGGER "reject_billing_events_update" BEFORE UPDATE ON "public"."billing_events" FOR EACH ROW EXECUTE FUNCTION "public"."reject_audit_modification"();



CREATE OR REPLACE TRIGGER "set_anchor_chain_index_updated_at" BEFORE UPDATE ON "public"."anchor_chain_index" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "set_anchor_version_trigger" BEFORE INSERT ON "public"."anchors" FOR EACH ROW EXECUTE FUNCTION "public"."set_anchor_version_number"();



CREATE OR REPLACE TRIGGER "set_anchors_updated_at" BEFORE UPDATE ON "public"."anchors" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_credential_templates_updated_at" BEFORE UPDATE ON "public"."credential_templates" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "set_organization_rules_updated_at" BEFORE UPDATE ON "public"."organization_rules" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_organizations_updated_at" BEFORE UPDATE ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_public_records_updated_at" BEFORE UPDATE ON "public"."public_records" FOR EACH ROW EXECUTE FUNCTION "public"."update_public_records_updated_at"();



CREATE OR REPLACE TRIGGER "set_webhook_delivery_log_public_id" BEFORE INSERT ON "public"."webhook_delivery_logs" FOR EACH ROW EXECUTE FUNCTION "public"."set_webhook_delivery_log_public_id"();



CREATE OR REPLACE TRIGGER "set_webhook_endpoint_public_id" BEFORE INSERT ON "public"."webhook_endpoints" FOR EACH ROW EXECUTE FUNCTION "public"."set_webhook_endpoint_public_id"();



CREATE OR REPLACE TRIGGER "subscriptions_updated_at" BEFORE UPDATE ON "public"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "switchboard_flag_change_trigger" AFTER UPDATE ON "public"."switchboard_flags" FOR EACH ROW WHEN (("old"."enabled" IS DISTINCT FROM "new"."enabled")) EXECUTE FUNCTION "public"."log_switchboard_flag_change"();



CREATE OR REPLACE TRIGGER "trg_check_sub_org_depth" BEFORE INSERT OR UPDATE OF "parent_org_id" ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."check_sub_org_depth"();



CREATE OR REPLACE TRIGGER "trg_compliance_audits_updated_at" BEFORE UPDATE ON "public"."compliance_audits" FOR EACH ROW EXECUTE FUNCTION "public"."touch_compliance_audits_updated_at"();



CREATE OR REPLACE TRIGGER "trg_credential_embeddings_updated_at" BEFORE UPDATE ON "public"."credential_embeddings" FOR EACH ROW EXECUTE FUNCTION "public"."update_credential_embeddings_updated_at"();



CREATE OR REPLACE TRIGGER "trg_credential_type_immutable" BEFORE UPDATE ON "public"."anchors" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_credential_type_change"();



CREATE OR REPLACE TRIGGER "trg_institution_ground_truth_updated_at" BEFORE UPDATE ON "public"."institution_ground_truth" FOR EACH ROW EXECUTE FUNCTION "public"."update_institution_ground_truth_updated_at"();



CREATE OR REPLACE TRIGGER "trg_prevent_direct_kyc_update" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_direct_kyc_update"();



CREATE OR REPLACE TRIGGER "trg_prevent_metadata_edit" BEFORE UPDATE ON "public"."anchors" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_metadata_edit_after_secured"();



CREATE OR REPLACE TRIGGER "trg_protect_platform_admin" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_platform_admin_flag"();



CREATE OR REPLACE TRIGGER "trg_review_queue_updated_at" BEFORE UPDATE ON "public"."review_queue_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_review_queue_updated_at"();



CREATE OR REPLACE TRIGGER "webhook_endpoints_updated_at" BEFORE UPDATE ON "public"."webhook_endpoints" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ai_credits"
    ADD CONSTRAINT "ai_credits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_credits"
    ADD CONSTRAINT "ai_credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_reports"
    ADD CONSTRAINT "ai_reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_reports"
    ADD CONSTRAINT "ai_reports_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_usage_events"
    ADD CONSTRAINT "ai_usage_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_usage_events"
    ADD CONSTRAINT "ai_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."anchor_chain_index"
    ADD CONSTRAINT "anchor_chain_index_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."anchor_proofs"
    ADD CONSTRAINT "anchor_proofs_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."anchor_queue_resolutions"
    ADD CONSTRAINT "anchor_queue_resolutions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."anchor_queue_resolutions"
    ADD CONSTRAINT "anchor_queue_resolutions_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."anchor_queue_resolutions"
    ADD CONSTRAINT "anchor_queue_resolutions_selected_anchor_id_fkey" FOREIGN KEY ("selected_anchor_id") REFERENCES "public"."anchors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."anchor_recipients"
    ADD CONSTRAINT "anchor_recipients_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."anchor_recipients"
    ADD CONSTRAINT "anchor_recipients_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."anchors"
    ADD CONSTRAINT "anchors_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."anchors"
    ADD CONSTRAINT "anchors_parent_anchor_id_fkey" FOREIGN KEY ("parent_anchor_id") REFERENCES "public"."anchors"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."anchors"
    ADD CONSTRAINT "anchors_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."anchors"
    ADD CONSTRAINT "anchors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_key_usage"
    ADD CONSTRAINT "api_key_usage_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_key_usage"
    ADD CONSTRAINT "api_key_usage_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ats_integrations"
    ADD CONSTRAINT "ats_integrations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."attestation_evidence"
    ADD CONSTRAINT "attestation_evidence_attestation_id_fkey" FOREIGN KEY ("attestation_id") REFERENCES "public"."attestations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attestations"
    ADD CONSTRAINT "attestations_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id");



ALTER TABLE ONLY "public"."attestations"
    ADD CONSTRAINT "attestations_attester_org_id_fkey" FOREIGN KEY ("attester_org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."audit_events"
    ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."audit_events"
    ADD CONSTRAINT "audit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."batch_verification_jobs"
    ADD CONSTRAINT "batch_verification_jobs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_events"
    ADD CONSTRAINT "billing_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_events"
    ADD CONSTRAINT "billing_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_events"
    ADD CONSTRAINT "billing_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cloud_logging_queue"
    ADD CONSTRAINT "cloud_logging_queue_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_audits"
    ADD CONSTRAINT "compliance_audits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_audits"
    ADD CONSTRAINT "compliance_audits_triggered_by_fkey" FOREIGN KEY ("triggered_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."compliance_scores"
    ADD CONSTRAINT "compliance_scores_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compliance_scores"
    ADD CONSTRAINT "compliance_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."connector_subscriptions"
    ADD CONSTRAINT "connector_subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."credential_embeddings"
    ADD CONSTRAINT "credential_embeddings_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."credential_embeddings"
    ADD CONSTRAINT "credential_embeddings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."credential_portfolios"
    ADD CONSTRAINT "credential_portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."credential_templates"
    ADD CONSTRAINT "credential_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."credential_templates"
    ADD CONSTRAINT "credential_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."credit_transactions"
    ADD CONSTRAINT "credit_transactions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."credit_transactions"
    ADD CONSTRAINT "credit_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."credits"
    ADD CONSTRAINT "credits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."credits"
    ADD CONSTRAINT "credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."data_subject_requests"
    ADD CONSTRAINT "data_subject_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drive_folder_path_cache"
    ADD CONSTRAINT "drive_folder_path_cache_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drive_revision_ledger"
    ADD CONSTRAINT "drive_revision_ledger_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."org_integrations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drive_revision_ledger"
    ADD CONSTRAINT "drive_revision_ledger_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emergency_access_grants"
    ADD CONSTRAINT "emergency_access_grants_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."emergency_access_grants"
    ADD CONSTRAINT "emergency_access_grants_grantee_id_fkey" FOREIGN KEY ("grantee_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emergency_access_grants"
    ADD CONSTRAINT "emergency_access_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emergency_access_grants"
    ADD CONSTRAINT "emergency_access_grants_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."entitlements"
    ADD CONSTRAINT "entitlements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."entitlements"
    ADD CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."extraction_feedback"
    ADD CONSTRAINT "extraction_feedback_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."extraction_feedback"
    ADD CONSTRAINT "extraction_feedback_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."extraction_feedback"
    ADD CONSTRAINT "extraction_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."extraction_manifests"
    ADD CONSTRAINT "extraction_manifests_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."extraction_manifests"
    ADD CONSTRAINT "extraction_manifests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."extraction_manifests"
    ADD CONSTRAINT "extraction_manifests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ferpa_disclosure_log"
    ADD CONSTRAINT "ferpa_disclosure_log_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ferpa_disclosure_log"
    ADD CONSTRAINT "ferpa_disclosure_log_disclosed_by_fkey" FOREIGN KEY ("disclosed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ferpa_disclosure_log"
    ADD CONSTRAINT "ferpa_disclosure_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "fk_signatures_archive_tst" FOREIGN KEY ("archive_timestamp_id") REFERENCES "public"."timestamp_tokens"("id");



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "fk_signatures_tst" FOREIGN KEY ("timestamp_token_id") REFERENCES "public"."timestamp_tokens"("id");



ALTER TABLE ONLY "public"."grc_connections"
    ADD CONSTRAINT "grc_connections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."grc_connections"
    ADD CONSTRAINT "grc_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."grc_sync_logs"
    ADD CONSTRAINT "grc_sync_logs_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."grc_sync_logs"
    ADD CONSTRAINT "grc_sync_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."grc_connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."integration_events"
    ADD CONSTRAINT "integration_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."org_integrations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."integration_events"
    ADD CONSTRAINT "integration_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."integrity_scores"
    ADD CONSTRAINT "integrity_scores_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."integrity_scores"
    ADD CONSTRAINT "integrity_scores_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."kyb_events"
    ADD CONSTRAINT "kyb_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_credit_allocations"
    ADD CONSTRAINT "org_credit_allocations_child_org_id_fkey" FOREIGN KEY ("child_org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."org_credit_allocations"
    ADD CONSTRAINT "org_credit_allocations_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."org_credit_allocations"
    ADD CONSTRAINT "org_credit_allocations_parent_org_id_fkey" FOREIGN KEY ("parent_org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."org_credits"
    ADD CONSTRAINT "org_credits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_daily_usage"
    ADD CONSTRAINT "org_daily_usage_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_integrations"
    ADD CONSTRAINT "org_integrations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_members"
    ADD CONSTRAINT "org_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."org_members"
    ADD CONSTRAINT "org_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_members"
    ADD CONSTRAINT "org_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_monthly_allocation"
    ADD CONSTRAINT "org_monthly_allocation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_rule_events"
    ADD CONSTRAINT "organization_rule_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_rule_executions"
    ADD CONSTRAINT "organization_rule_executions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_rule_executions"
    ADD CONSTRAINT "organization_rule_executions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."organization_rules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_rules"
    ADD CONSTRAINT "organization_rules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organization_rules"
    ADD CONSTRAINT "organization_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_parent_org_id_fkey" FOREIGN KEY ("parent_org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_suspended_by_fkey" FOREIGN KEY ("suspended_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."parent_split_tokens"
    ADD CONSTRAINT "parent_split_tokens_parent_org_id_fkey" FOREIGN KEY ("parent_org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."parent_split_tokens"
    ADD CONSTRAINT "parent_split_tokens_sub_org_id_fkey" FOREIGN KEY ("sub_org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_grace_periods"
    ADD CONSTRAINT "payment_grace_periods_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id");



ALTER TABLE ONLY "public"."payment_grace_periods"
    ADD CONSTRAINT "payment_grace_periods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."public_record_embeddings"
    ADD CONSTRAINT "public_record_embeddings_public_record_id_fkey" FOREIGN KEY ("public_record_id") REFERENCES "public"."public_records"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."public_records"
    ADD CONSTRAINT "public_records_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id");



ALTER TABLE ONLY "public"."report_artifacts"
    ADD CONSTRAINT "report_artifacts_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_queue_items"
    ADD CONSTRAINT "review_queue_items_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_queue_items"
    ADD CONSTRAINT "review_queue_items_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."review_queue_items"
    ADD CONSTRAINT "review_queue_items_integrity_score_id_fkey" FOREIGN KEY ("integrity_score_id") REFERENCES "public"."integrity_scores"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."review_queue_items"
    ADD CONSTRAINT "review_queue_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_queue_items"
    ADD CONSTRAINT "review_queue_items_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "signatures_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id");



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "signatures_attestation_id_fkey" FOREIGN KEY ("attestation_id") REFERENCES "public"."attestations"("id");



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "signatures_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "signatures_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."signatures"
    ADD CONSTRAINT "signatures_signer_certificate_id_fkey" FOREIGN KEY ("signer_certificate_id") REFERENCES "public"."signing_certificates"("id");



ALTER TABLE ONLY "public"."signing_certificates"
    ADD CONSTRAINT "signing_certificates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."signing_certificates"
    ADD CONSTRAINT "signing_certificates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."timestamp_tokens"
    ADD CONSTRAINT "timestamp_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."timestamp_tokens"
    ADD CONSTRAINT "timestamp_tokens_signature_id_fkey" FOREIGN KEY ("signature_id") REFERENCES "public"."signatures"("id");



ALTER TABLE ONLY "public"."unified_credits"
    ADD CONSTRAINT "unified_credits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."unified_credits"
    ADD CONSTRAINT "unified_credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."user_notifications"
    ADD CONSTRAINT "user_notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_notifications"
    ADD CONSTRAINT "user_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."verification_events"
    ADD CONSTRAINT "verification_events_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "public"."anchors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."verification_events"
    ADD CONSTRAINT "verification_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."webhook_delivery_logs"
    ADD CONSTRAINT "webhook_delivery_logs_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."x402_payments"
    ADD CONSTRAINT "x402_payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



CREATE POLICY "Anyone can read jurisdiction rules" ON "public"."jurisdiction_rules" FOR SELECT USING (true);



CREATE POLICY "Authenticated users can read public_records" ON "public"."public_records" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Individuals can insert recipients for own anchors" ON "public"."anchor_recipients" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."anchors" "a"
  WHERE (("a"."id" = "anchor_recipients"."anchor_id") AND ("a"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "Org admins can create invitations" ON "public"."invitations" FOR INSERT WITH CHECK (("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."role" = 'ORG_ADMIN'::"public"."user_role")))));



CREATE POLICY "Org admins can insert recipients" ON "public"."anchor_recipients" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."anchors" "a"
     JOIN "public"."profiles" "p" ON (("p"."id" = ( SELECT "auth"."uid"() AS "uid"))))
  WHERE (("a"."id" = "anchor_recipients"."anchor_id") AND ("a"."org_id" = "p"."org_id") AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role")))));



CREATE POLICY "Org admins can mark notifications read" ON "public"."notifications" FOR UPDATE USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE (("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("org_members"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "Org admins can view invitations" ON "public"."invitations" FOR SELECT USING (("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role")))));



CREATE POLICY "Org members can read their org audits" ON "public"."compliance_audits" FOR SELECT USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Org members can read their org notifications" ON "public"."notifications" FOR SELECT USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Org members can read their org scores" ON "public"."compliance_scores" FOR SELECT USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "Recipients can view own credentials" ON "public"."anchor_recipients" FOR SELECT TO "authenticated" USING (("recipient_user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "Service role full access" ON "public"."anchor_recipients" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on public_record_embeddings" ON "public"."public_record_embeddings" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access on public_records" ON "public"."public_records" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access on x402_payments" ON "public"."x402_payments" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."adobe_sign_webhook_nonces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "adobe_sign_webhook_nonces_service" ON "public"."adobe_sign_webhook_nonces" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."agents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agents_delete_admin" ON "public"."agents" FOR DELETE TO "authenticated" USING ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



CREATE POLICY "agents_insert_admin" ON "public"."agents" FOR INSERT TO "authenticated" WITH CHECK ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



CREATE POLICY "agents_select_org" ON "public"."agents" FOR SELECT TO "authenticated" USING (("org_id" = "public"."get_user_org_id"()));



CREATE POLICY "agents_service_role" ON "public"."agents" TO "service_role" USING (true);



CREATE POLICY "agents_update_admin" ON "public"."agents" FOR UPDATE TO "authenticated" USING ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



ALTER TABLE "public"."ai_credits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_credits_insert" ON "public"."ai_credits" FOR INSERT WITH CHECK (false);



CREATE POLICY "ai_credits_select" ON "public"."ai_credits" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "user_id") OR ("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "ai_credits_update" ON "public"."ai_credits" FOR UPDATE USING (false);



ALTER TABLE "public"."ai_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_reports_insert" ON "public"."ai_reports" FOR INSERT WITH CHECK ((("requested_by" = ( SELECT "auth"."uid"() AS "uid")) AND ("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "ai_reports_select" ON "public"."ai_reports" FOR SELECT USING (("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."ai_usage_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_usage_events_insert" ON "public"."ai_usage_events" FOR INSERT WITH CHECK (false);



CREATE POLICY "ai_usage_events_select" ON "public"."ai_usage_events" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "user_id") OR ("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."anchor_chain_index" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anchor_chain_index_no_user_access" ON "public"."anchor_chain_index" TO "authenticated", "anon" USING (false) WITH CHECK (false);



ALTER TABLE "public"."anchor_proofs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anchor_proofs_admin_only" ON "public"."anchor_proofs" FOR SELECT TO "authenticated" USING ((("anchor_id" IN ( SELECT "anchors"."id"
   FROM "public"."anchors"
  WHERE ("anchors"."org_id" = "public"."get_user_org_id"()))) AND "public"."is_org_admin"()));



ALTER TABLE "public"."anchor_queue_resolutions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anchor_queue_resolutions_select" ON "public"."anchor_queue_resolutions" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."anchor_recipients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anchor_recipients_select" ON "public"."anchor_recipients" FOR SELECT TO "authenticated" USING (("recipient_user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."anchors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anchors_insert_own" ON "public"."anchors" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = 'PENDING'::"public"."anchor_status") AND (("org_id" IS NULL) OR ("org_id" = "public"."get_user_org_id"()))));



COMMENT ON POLICY "anchors_insert_own" ON "public"."anchors" IS 'Users can create anchors for themselves with status PENDING';



CREATE POLICY "anchors_select_org" ON "public"."anchors" FOR SELECT TO "authenticated" USING (("org_id" = "public"."get_user_org_id"()));



CREATE POLICY "anchors_select_own" ON "public"."anchors" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



COMMENT ON POLICY "anchors_select_own" ON "public"."anchors" IS 'Users can view their own anchors';



CREATE POLICY "anchors_select_platform_admin" ON "public"."anchors" FOR SELECT TO "authenticated" USING ("public"."is_current_user_platform_admin"());



CREATE POLICY "anchors_update_own" ON "public"."anchors" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



COMMENT ON POLICY "anchors_update_own" ON "public"."anchors" IS 'Users can update their own anchors (protected fields blocked by trigger)';



ALTER TABLE "public"."api_key_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "api_key_usage_select" ON "public"."api_key_usage" FOR SELECT TO "authenticated" USING ((("api_key_id" IN ( SELECT "api_keys"."id"
   FROM "public"."api_keys"
  WHERE ("api_keys"."org_id" = ( SELECT "profiles"."org_id"
           FROM "public"."profiles"
          WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))))) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid"))) = 'ORG_ADMIN'::"public"."user_role")));



CREATE POLICY "api_key_usage_select_own_org" ON "public"."api_key_usage" FOR SELECT TO "authenticated" USING (("org_id" = "public"."get_user_org_id"()));



CREATE POLICY "api_key_usage_service_role_all" ON "public"."api_key_usage" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "api_keys_select" ON "public"."api_keys" FOR SELECT TO "authenticated" USING ((("org_id" = ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid"))) = 'ORG_ADMIN'::"public"."user_role")));



CREATE POLICY "api_keys_select_own_org" ON "public"."api_keys" FOR SELECT TO "authenticated" USING (("org_id" = "public"."get_user_org_id"()));



CREATE POLICY "api_keys_service_role_all" ON "public"."api_keys" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "ats_integration_org_member" ON "public"."ats_integrations" USING (("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."ats_integrations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ats_webhook_nonces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ats_webhook_nonces_service" ON "public"."ats_webhook_nonces" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."attestation_evidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attestations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attestations_insert" ON "public"."attestations" FOR INSERT WITH CHECK (("attester_user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "attestations_select" ON "public"."attestations" FOR SELECT TO "authenticated" USING ((("attester_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("attester_org_id" = "public"."get_user_org_id"()) OR (EXISTS ( SELECT 1
   FROM "public"."anchors" "a"
  WHERE (("a"."id" = "attestations"."anchor_id") AND ("a"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) OR ("status" = 'ACTIVE'::"public"."attestation_status")));



CREATE POLICY "attestations_select_platform_admin" ON "public"."attestations" FOR SELECT TO "authenticated" USING ("public"."is_current_user_platform_admin"());



CREATE POLICY "attestations_update" ON "public"."attestations" FOR UPDATE USING (("attester_user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."audit_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_events_archive" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_events_archive_no_user_access" ON "public"."audit_events_archive" TO "authenticated", "anon" USING (false) WITH CHECK (false);



CREATE POLICY "audit_events_insert_own" ON "public"."audit_events" FOR INSERT TO "authenticated" WITH CHECK (("actor_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "audit_events_no_delete" ON "public"."audit_events" FOR DELETE TO "authenticated", "anon" USING (false);



CREATE POLICY "audit_events_no_update" ON "public"."audit_events" FOR UPDATE TO "authenticated", "anon" USING (false) WITH CHECK (false);



CREATE POLICY "audit_events_select" ON "public"."audit_events" FOR SELECT TO "authenticated" USING (("actor_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "audit_events_select_own" ON "public"."audit_events" FOR SELECT TO "authenticated" USING (("actor_id" = ( SELECT "auth"."uid"() AS "uid")));



COMMENT ON POLICY "audit_events_select_own" ON "public"."audit_events" IS 'Users can only read audit events where they are the actor';



CREATE POLICY "authenticated_read_only" ON "public"."institution_ground_truth" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "batch_jobs_service_all" ON "public"."batch_verification_jobs" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."batch_verification_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_events_read_own" ON "public"."billing_events" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("org_id" = "public"."get_user_org_id"())));



ALTER TABLE "public"."checkr_webhook_nonces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "checkr_webhook_nonces_service" ON "public"."checkr_webhook_nonces" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."cloud_logging_queue" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cloud_logging_queue_no_user_access" ON "public"."cloud_logging_queue" TO "authenticated", "anon" USING (false) WITH CHECK (false);



ALTER TABLE "public"."compliance_audits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."compliance_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."connector_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connector_subscriptions_select" ON "public"."connector_subscriptions" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "connector_subscriptions_service" ON "public"."connector_subscriptions" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."credential_embeddings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "credential_embeddings_delete" ON "public"."credential_embeddings" FOR DELETE USING (false);



CREATE POLICY "credential_embeddings_insert" ON "public"."credential_embeddings" FOR INSERT WITH CHECK (false);



CREATE POLICY "credential_embeddings_select" ON "public"."credential_embeddings" FOR SELECT USING (("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."credential_portfolios" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."credential_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "credential_templates_delete" ON "public"."credential_templates" FOR DELETE TO "authenticated" USING (("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role")))));



CREATE POLICY "credential_templates_insert" ON "public"."credential_templates" FOR INSERT TO "authenticated" WITH CHECK ((("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role")))) AND (("created_by" IS NULL) OR ("created_by" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "credential_templates_select" ON "public"."credential_templates" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "credential_templates_select_system" ON "public"."credential_templates" FOR SELECT TO "authenticated" USING (("is_system" = true));



CREATE POLICY "credential_templates_update" ON "public"."credential_templates" FOR UPDATE TO "authenticated" USING (("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role"))))) WITH CHECK (("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role")))));



ALTER TABLE "public"."credit_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "credit_transactions_select" ON "public"."credit_transactions" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "credit_transactions_service_all" ON "public"."credit_transactions" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."credits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "credits_select" ON "public"."credits" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "credits_service_all" ON "public"."credits" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."data_subject_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "data_subject_requests_insert_own" ON "public"."data_subject_requests" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "data_subject_requests_select_own" ON "public"."data_subject_requests" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."docusign_webhook_nonces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "docusign_webhook_nonces_service" ON "public"."docusign_webhook_nonces" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."drive_folder_path_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drive_folder_path_cache_service_role" ON "public"."drive_folder_path_cache" TO "service_role" USING (true) WITH CHECK (true);



COMMENT ON POLICY "drive_folder_path_cache_service_role" ON "public"."drive_folder_path_cache" IS 'SCRUM-1275 (R3-2): explicit service_role policy. Frontend never reads this cache; callers go through services/worker resolveDriveFolderPath which uses service_role.';



ALTER TABLE "public"."drive_revision_ledger" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drive_revision_ledger_org_select" ON "public"."drive_revision_ledger" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."org_id" = "drive_revision_ledger"."org_id")))));



CREATE POLICY "drive_revision_ledger_service" ON "public"."drive_revision_ledger" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."drive_webhook_nonces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drive_webhook_nonces_service" ON "public"."drive_webhook_nonces" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."emergency_access_grants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emergency_access_insert" ON "public"."emergency_access_grants" FOR INSERT WITH CHECK (("public"."get_caller_role"() = 'service_role'::"text"));



CREATE POLICY "emergency_access_select" ON "public"."emergency_access_grants" FOR SELECT USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "emergency_access_update" ON "public"."emergency_access_grants" FOR UPDATE USING (("public"."get_caller_role"() = 'service_role'::"text"));



ALTER TABLE "public"."entitlements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "entitlements_read_own" ON "public"."entitlements" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("org_id" = "public"."get_user_org_id"())));



CREATE POLICY "evidence_insert" ON "public"."attestation_evidence" FOR INSERT WITH CHECK (("uploaded_by" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "evidence_select" ON "public"."attestation_evidence" FOR SELECT USING (("attestation_id" IN ( SELECT "attestations"."id"
   FROM "public"."attestations"
  WHERE (("attestations"."attester_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("attestations"."attester_org_id" IN ( SELECT "profiles"."org_id"
           FROM "public"."profiles"
          WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))) OR ("attestations"."status" = 'ACTIVE'::"public"."attestation_status")))));



ALTER TABLE "public"."extraction_feedback" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "extraction_feedback_insert" ON "public"."extraction_feedback" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "extraction_feedback_select" ON "public"."extraction_feedback" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("org_id" = "public"."get_user_org_id"())));



ALTER TABLE "public"."extraction_manifests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "extraction_manifests_org_read" ON "public"."extraction_manifests" FOR SELECT USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "extraction_manifests_own_read" ON "public"."extraction_manifests" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "extraction_manifests_service" ON "public"."extraction_manifests" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "ferpa_disclosure_insert" ON "public"."ferpa_disclosure_log" FOR INSERT WITH CHECK (("public"."get_caller_role"() = 'service_role'::"text"));



ALTER TABLE "public"."ferpa_disclosure_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ferpa_disclosure_select" ON "public"."ferpa_disclosure_log" FOR SELECT USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role", 'compliance_officer'::"public"."org_member_role"]))))));



ALTER TABLE "public"."financial_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."freemail_domains" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "freemail_domains_select" ON "public"."freemail_domains" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."grc_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "grc_connections_delete" ON "public"."grc_connections" FOR DELETE TO "authenticated" USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "grc_connections_insert" ON "public"."grc_connections" FOR INSERT TO "authenticated" WITH CHECK (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "grc_connections_select" ON "public"."grc_connections" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "grc_connections_service" ON "public"."grc_connections" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "grc_connections_update" ON "public"."grc_connections" FOR UPDATE TO "authenticated" USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



ALTER TABLE "public"."grc_sync_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "grc_sync_logs_select" ON "public"."grc_sync_logs" FOR SELECT TO "authenticated" USING (("connection_id" IN ( SELECT "gc"."id"
   FROM ("public"."grc_connections" "gc"
     JOIN "public"."org_members" "om" ON (("gc"."org_id" = "om"."org_id")))
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "grc_sync_logs_service" ON "public"."grc_sync_logs" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."institution_ground_truth" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."integration_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "integration_events_select_org_admin" ON "public"."integration_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."org_members" "om"
  WHERE (("om"."org_id" = "integration_events"."org_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['admin'::"public"."org_member_role", 'owner'::"public"."org_member_role"]))))));



ALTER TABLE "public"."integrity_scores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "integrity_scores_select" ON "public"."integrity_scores" FOR SELECT USING (("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_queue" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_queue_no_user_access" ON "public"."job_queue" TO "authenticated", "anon" USING (false) WITH CHECK (false);



ALTER TABLE "public"."jurisdiction_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kyb_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kyb_events_select_org_admin" ON "public"."kyb_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."org_members" "om"
  WHERE (("om"."org_id" = "kyb_events"."org_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['admin'::"public"."org_member_role", 'owner'::"public"."org_member_role"]))))));



ALTER TABLE "public"."kyb_webhook_nonces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kyb_webhook_nonces_service_role" ON "public"."kyb_webhook_nonces" TO "service_role" USING (true) WITH CHECK (true);



COMMENT ON POLICY "kyb_webhook_nonces_service_role" ON "public"."kyb_webhook_nonces" IS 'SCRUM-1275 (R3-2): explicit service_role policy. Worker-only writes from middesk + docusign webhook handlers for replay-protection nonce storage.';



ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "memberships_select_org" ON "public"."memberships" FOR SELECT TO "authenticated" USING ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



CREATE POLICY "memberships_select_org_members" ON "public"."memberships" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."memberships" "m_self"
  WHERE (("m_self"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("m_self"."org_id" = "memberships"."org_id")))));



CREATE POLICY "memberships_select_own" ON "public"."memberships" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "memberships_select_self" ON "public"."memberships" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "memberships_service_all" ON "public"."memberships" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_select_own" ON "public"."user_notifications" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "notifications_service_insert" ON "public"."user_notifications" FOR INSERT WITH CHECK (("public"."get_caller_role"() = 'service_role'::"text"));



CREATE POLICY "notifications_update_own" ON "public"."user_notifications" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."org_credit_allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_credit_allocations_select" ON "public"."org_credit_allocations" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("om"."org_id" = "org_credit_allocations"."parent_org_id") OR ("om"."org_id" = "org_credit_allocations"."child_org_id"))))));



ALTER TABLE "public"."org_credits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_credits_select" ON "public"."org_credits" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."org_members" "om"
  WHERE (("om"."org_id" = "org_credits"."org_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."org_daily_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_daily_usage_select" ON "public"."org_daily_usage" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."org_integrations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_integrations_select_org_admin" ON "public"."org_integrations" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."org_members" "om"
  WHERE (("om"."org_id" = "org_integrations"."org_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['admin'::"public"."org_member_role", 'owner'::"public"."org_member_role"]))))));



ALTER TABLE "public"."org_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_members_delete" ON "public"."org_members" FOR DELETE TO "authenticated" USING (("public"."is_org_admin_of"("org_id") AND ("user_id" <> ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "org_members_insert" ON "public"."org_members" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_admin_of"("org_id"));



CREATE POLICY "org_members_select_org" ON "public"."org_members" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "public"."get_user_org_ids"() AS "get_user_org_ids")));



CREATE POLICY "org_members_select_own" ON "public"."org_members" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "org_members_self_leave" ON "public"."org_members" FOR DELETE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "org_members_update" ON "public"."org_members" FOR UPDATE TO "authenticated" USING (("public"."is_org_admin_of"("org_id") AND ("user_id" <> ( SELECT "auth"."uid"() AS "uid")))) WITH CHECK ("public"."is_org_admin_of"("org_id"));



ALTER TABLE "public"."org_monthly_allocation" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_monthly_allocation_select_members" ON "public"."org_monthly_allocation" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."org_members" "om"
  WHERE (("om"."org_id" = "org_monthly_allocation"."org_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."org_tier_entitlements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_tier_entitlements_select" ON "public"."org_tier_entitlements" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."organization_rule_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organization_rule_events_select" ON "public"."organization_rule_events" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."organization_rule_executions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organization_rule_executions_select" ON "public"."organization_rule_executions" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."organization_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organization_rules_delete" ON "public"."organization_rules" FOR DELETE TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE (("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("org_members"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "organization_rules_insert" ON "public"."organization_rules" FOR INSERT TO "authenticated" WITH CHECK (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE (("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("org_members"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "organization_rules_select" ON "public"."organization_rules" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE ("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "organization_rules_update" ON "public"."organization_rules" FOR UPDATE TO "authenticated" USING (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE (("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("org_members"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"])))))) WITH CHECK (("org_id" IN ( SELECT "org_members"."org_id"
   FROM "public"."org_members"
  WHERE (("org_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("org_members"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organizations_select_member" ON "public"."organizations" FOR SELECT TO "authenticated" USING (("id" IN ( SELECT "public"."get_user_org_ids"() AS "get_user_org_ids")));



CREATE POLICY "organizations_update_admin" ON "public"."organizations" FOR UPDATE TO "authenticated" USING ("public"."is_org_admin_of"("id")) WITH CHECK ("public"."is_org_admin_of"("id"));



ALTER TABLE "public"."parent_split_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "parent_split_tokens_service_role" ON "public"."parent_split_tokens" TO "service_role" USING (true) WITH CHECK (true);



COMMENT ON POLICY "parent_split_tokens_service_role" ON "public"."parent_split_tokens" IS 'SCRUM-1275 (R3-2): explicit service_role policy. Tokens looked up by hash via service_role only in the Phase 3b sub-org rollover flow.';



ALTER TABLE "public"."payment_grace_periods" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pdc_admin_read" ON "public"."pipeline_dashboard_cache" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_platform_admin" = true)))));



ALTER TABLE "public"."pipeline_dashboard_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plans_read_active" ON "public"."plans" FOR SELECT TO "authenticated" USING (("is_active" = true));



CREATE POLICY "portfolio_owner_all" ON "public"."credential_portfolios" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "portfolio_public_read" ON "public"."credential_portfolios" FOR SELECT USING ((("expires_at" IS NULL) OR ("expires_at" > "now"())));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_hide_deleted" ON "public"."profiles" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (("deleted_at" IS NULL));



CREATE POLICY "profiles_select_org_members" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("org_id" IS NOT NULL) AND ("org_id" = "public"."get_user_org_id"())));



COMMENT ON POLICY "profiles_select_org_members" ON "public"."profiles" IS 'Org members can view all profiles within their organization';



CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."public_record_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."public_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reconciliation_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."report_artifacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "report_artifacts_read_own" ON "public"."report_artifacts" FOR SELECT TO "authenticated" USING (("report_id" IN ( SELECT "reports"."id"
   FROM "public"."reports"
  WHERE (("reports"."user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("reports"."org_id" = "public"."get_user_org_id"())))));



ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reports_insert_own" ON "public"."reports" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("org_id" IS NULL) OR ("org_id" = "public"."get_user_org_id"()))));



CREATE POLICY "reports_read_own" ON "public"."reports" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("org_id" = "public"."get_user_org_id"())));



CREATE POLICY "reports_read_own_or_admin" ON "public"."reports" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR (("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"())));



ALTER TABLE "public"."review_queue_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "review_queue_select" ON "public"."review_queue_items" FOR SELECT USING (("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "review_queue_update" ON "public"."review_queue_items" FOR UPDATE USING (("org_id" IN ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role")))));



ALTER TABLE "public"."rule_embeddings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rule_embeddings_no_user_access" ON "public"."rule_embeddings" TO "authenticated", "anon" USING (false) WITH CHECK (false);



CREATE POLICY "service_role_full_access" ON "public"."institution_ground_truth" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_full_access" ON "public"."webhook_dead_letter_queue" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_manage_financial_reports" ON "public"."financial_reports" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_manage_grace_periods" ON "public"."payment_grace_periods" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_manage_reconciliation" ON "public"."reconciliation_reports" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_manage_unified_credits" ON "public"."unified_credits" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."signatures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "signatures_insert" ON "public"."signatures" FOR INSERT WITH CHECK (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "signatures_select" ON "public"."signatures" FOR SELECT USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "signatures_service" ON "public"."signatures" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "signatures_update" ON "public"."signatures" FOR UPDATE USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



ALTER TABLE "public"."signing_certificates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "signing_certs_insert" ON "public"."signing_certificates" FOR INSERT WITH CHECK (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



CREATE POLICY "signing_certs_select" ON "public"."signing_certificates" FOR SELECT USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "signing_certs_service" ON "public"."signing_certificates" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "signing_certs_update" ON "public"."signing_certificates" FOR UPDATE USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE (("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = ANY (ARRAY['owner'::"public"."org_member_role", 'admin'::"public"."org_member_role"]))))));



ALTER TABLE "public"."stats_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stats_cache_select" ON "public"."stats_cache" FOR SELECT USING (true);



ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscriptions_read_own" ON "public"."subscriptions" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("org_id" = "public"."get_user_org_id"())));



CREATE POLICY "subscriptions_select" ON "public"."subscriptions" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."switchboard_flag_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "switchboard_flag_history_no_user_deletes" ON "public"."switchboard_flag_history" FOR DELETE TO "authenticated", "anon" USING (false);



CREATE POLICY "switchboard_flag_history_no_user_updates" ON "public"."switchboard_flag_history" FOR UPDATE TO "authenticated", "anon" USING (false) WITH CHECK (false);



CREATE POLICY "switchboard_flag_history_no_user_writes" ON "public"."switchboard_flag_history" FOR INSERT TO "authenticated", "anon" WITH CHECK (false);



ALTER TABLE "public"."switchboard_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "switchboard_flags_no_user_deletes" ON "public"."switchboard_flags" FOR DELETE TO "authenticated", "anon" USING (false);



CREATE POLICY "switchboard_flags_no_user_updates" ON "public"."switchboard_flags" FOR UPDATE TO "authenticated", "anon" USING (false) WITH CHECK (false);



CREATE POLICY "switchboard_flags_no_user_writes" ON "public"."switchboard_flags" FOR INSERT TO "authenticated", "anon" WITH CHECK (false);



CREATE POLICY "switchboard_flags_select_platform_admin" ON "public"."switchboard_flags" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_platform_admin" = true)))));



ALTER TABLE "public"."timestamp_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."treasury_alert_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "treasury_alert_state_select" ON "public"."treasury_alert_state" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_platform_admin" = true)))));



ALTER TABLE "public"."treasury_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "treasury_cache_select" ON "public"."treasury_cache" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_platform_admin" = true)))));



CREATE POLICY "treasury_cache_service_write" ON "public"."treasury_cache" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "tst_select" ON "public"."timestamp_tokens" FOR SELECT USING (("org_id" IN ( SELECT "om"."org_id"
   FROM "public"."org_members" "om"
  WHERE ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "tst_service" ON "public"."timestamp_tokens" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."unified_credits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_read_own_grace_periods" ON "public"."payment_grace_periods" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "users_read_own_unified_credits" ON "public"."unified_credits" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "user_id") OR ("org_id" IN ( SELECT "profiles"."org_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."verification_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "verification_events_org_admin_select" ON "public"."verification_events" FOR SELECT TO "authenticated" USING ((("org_id" IS NOT NULL) AND ("org_id" = ( SELECT "p"."org_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = ( SELECT "auth"."uid"() AS "uid")))) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."role" = 'ORG_ADMIN'::"public"."user_role"))))));



ALTER TABLE "public"."webhook_dead_letter_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."webhook_delivery_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "webhook_delivery_logs_read_org" ON "public"."webhook_delivery_logs" FOR SELECT TO "authenticated" USING ((("endpoint_id" IN ( SELECT "webhook_endpoints"."id"
   FROM "public"."webhook_endpoints"
  WHERE ("webhook_endpoints"."org_id" = "public"."get_user_org_id"()))) AND "public"."is_org_admin"()));



ALTER TABLE "public"."webhook_dlq" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "webhook_dlq_service" ON "public"."webhook_dlq" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."webhook_endpoints" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "webhook_endpoints_delete_org" ON "public"."webhook_endpoints" FOR DELETE TO "authenticated" USING ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



CREATE POLICY "webhook_endpoints_insert_org" ON "public"."webhook_endpoints" FOR INSERT TO "authenticated" WITH CHECK ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



CREATE POLICY "webhook_endpoints_read_org" ON "public"."webhook_endpoints" FOR SELECT TO "authenticated" USING ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



CREATE POLICY "webhook_endpoints_update_org" ON "public"."webhook_endpoints" FOR UPDATE TO "authenticated" USING ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"())) WITH CHECK ((("org_id" = "public"."get_user_org_id"()) AND "public"."is_org_admin"()));



ALTER TABLE "public"."x402_payments" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."activate_user"("p_token" "text", "p_password" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."activate_user"("p_token" "text", "p_password" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."activate_user"("p_token" "text", "p_password" "text") TO "anon";



REVOKE ALL ON FUNCTION "public"."admin_change_user_role"("p_user_id" "uuid", "p_new_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_change_user_role"("p_user_id" "uuid", "p_new_role" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_set_platform_admin"("p_user_id" "uuid", "p_is_admin" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_platform_admin"("p_user_id" "uuid", "p_is_admin" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_set_user_org"("p_user_id" "uuid", "p_org_id" "uuid", "p_org_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_user_org"("p_user_id" "uuid", "p_org_id" "uuid", "p_org_role" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."allocate_credits_to_sub_org"("p_parent_org_id" "uuid", "p_child_org_id" "uuid", "p_amount" integer, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."allocate_credits_to_sub_org"("p_parent_org_id" "uuid", "p_child_org_id" "uuid", "p_amount" integer, "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."allocate_credits_to_sub_org"("p_parent_org_id" "uuid", "p_child_org_id" "uuid", "p_amount" integer, "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_credits_to_sub_org"("p_parent_org_id" "uuid", "p_child_org_id" "uuid", "p_amount" integer, "p_note" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."allocate_monthly_credits"() TO "anon";
GRANT ALL ON FUNCTION "public"."allocate_monthly_credits"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_monthly_credits"() TO "service_role";



GRANT ALL ON FUNCTION "public"."anonymize_member_display_name"("p_full_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."anonymize_member_display_name"("p_full_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."anonymize_member_display_name"("p_full_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."anonymize_user_data"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."anonymize_user_data"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."archive_old_audit_events"("retention_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."archive_old_audit_events"("retention_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."archive_old_audit_events"("retention_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."archive_old_audit_events"("retention_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_associate_profile_to_org_by_email_domain"("p_user_id" "uuid", "p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."auto_associate_profile_to_org_by_email_domain"("p_user_id" "uuid", "p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_associate_profile_to_org_by_email_domain"("p_user_id" "uuid", "p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_generate_org_prefix"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_generate_org_prefix"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_generate_org_prefix"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_generate_org_public_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_generate_org_public_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_generate_org_public_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_generate_profile_public_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_generate_profile_public_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_generate_profile_public_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_generate_public_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_generate_public_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_generate_public_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."batch_insert_anchors"("p_anchors" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_create_anchors"("anchors_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."bulk_promote_confirmed"("p_tx_ids" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."bulk_promote_confirmed"("p_tx_ids" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_promote_confirmed"("p_tx_ids" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."can_export_user_data"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_export_user_data"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."check_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_anchor_quota"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_anchor_quota"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_anchor_quota"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_orphaned_anchors"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_orphaned_anchors"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_orphaned_anchors"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_orphaned_anchors"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_role_immutability"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_role_immutability"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_role_immutability"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_role_immutability"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_sub_org_depth"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_sub_org_depth"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_sub_org_depth"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."check_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."job_queue" TO "anon";
GRANT ALL ON TABLE "public"."job_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."job_queue" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_next_job"("p_type" "text", "p_now" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_next_job"("p_type" "text", "p_now" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_next_job"("p_type" "text", "p_now" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_pending_anchors"("p_worker_id" "text", "p_limit" integer, "p_exclude_pipeline" boolean, "p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_pending_anchors"("p_worker_id" "text", "p_limit" integer, "p_exclude_pipeline" boolean, "p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_pending_anchors"("p_worker_id" "text", "p_limit" integer, "p_exclude_pipeline" boolean, "p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_pending_anchors"("p_worker_id" "text", "p_limit" integer, "p_exclude_pipeline" boolean, "p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_pending_rule_events"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_pending_rule_events"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_pending_rule_events"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_expired_data"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_expired_data"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_orphaned_anchors"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_orphaned_anchors"() TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_orphaned_anchors"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_orphaned_anchors"() TO "service_role";



GRANT ALL ON FUNCTION "public"."clear_payment_grace"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."clear_payment_grace"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_payment_grace"("p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_claimed_rule_events"("p_event_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_claimed_rule_events"("p_event_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."complete_claimed_rule_events"("p_event_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."count_public_records_by_source"() TO "anon";
GRANT ALL ON FUNCTION "public"."count_public_records_by_source"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."count_public_records_by_source"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_pending_recipient"("p_email" "text", "p_org_id" "uuid", "p_full_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_pending_recipient"("p_email" "text", "p_org_id" "uuid", "p_full_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_pending_recipient"("p_email" "text", "p_org_id" "uuid", "p_full_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_profile_for_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_profile_for_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_profile_for_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_webhook_endpoint"("p_url" "text", "p_events" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."create_webhook_endpoint"("p_url" "text", "p_events" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_webhook_endpoint"("p_url" "text", "p_events" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deduct_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deduct_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deduct_ai_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deduct_credit"("p_user_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deduct_credit"("p_user_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deduct_credit"("p_user_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."deduct_org_credit"("p_org_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deduct_org_credit"("p_org_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deduct_org_credit"("p_org_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deduct_org_credit"("p_org_id" "uuid", "p_amount" integer, "p_reason" "text", "p_reference_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deduct_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deduct_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deduct_unified_credits"("p_org_id" "uuid", "p_user_id" "uuid", "p_amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_own_account"() TO "anon";
GRANT ALL ON FUNCTION "public"."delete_own_account"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_own_account"() TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_webhook_endpoint"("p_endpoint_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_webhook_endpoint"("p_endpoint_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_webhook_endpoint"("p_endpoint_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."drain_submitted_to_secured_for_tx"("p_chain_tx_id" "text", "p_block_height" integer, "p_block_timestamp" timestamp with time zone, "p_batch_size" integer, "p_max_iterations" integer, "p_confirmations" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_lowercase_email"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_lowercase_email"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_lowercase_email"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_lowercase_email"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_org_parent_depth"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_org_parent_depth"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_org_parent_depth"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enqueue_audit_for_cloud_logging"() TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_audit_for_cloud_logging"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enqueue_audit_for_cloud_logging"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_rule_event"("p_org_id" "uuid", "p_trigger_type" "public"."org_rule_trigger_type", "p_vendor" "text", "p_external_file_id" "text", "p_filename" "text", "p_folder_path" "text", "p_sender_email" "text", "p_subject" "text", "p_payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_rule_event"("p_org_id" "uuid", "p_trigger_type" "public"."org_rule_trigger_type", "p_vendor" "text", "p_external_file_id" "text", "p_filename" "text", "p_folder_path" "text", "p_sender_email" "text", "p_subject" "text", "p_payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_rule_event"("p_org_id" "uuid", "p_trigger_type" "public"."org_rule_trigger_type", "p_vendor" "text", "p_external_file_id" "text", "p_filename" "text", "p_folder_path" "text", "p_sender_email" "text", "p_subject" "text", "p_payload" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."expire_payment_grace_if_due"() TO "anon";
GRANT ALL ON FUNCTION "public"."expire_payment_grace_if_due"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."expire_payment_grace_if_due"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."finalize_public_record_anchor_batch"("p_items" "jsonb", "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_public_record_anchor_batch"("p_items" "jsonb", "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."finalize_public_record_anchor_batch"("p_items" "jsonb", "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."finalize_public_record_anchor_batch"("p_items" "jsonb", "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_anchor_public_id"("category" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_anchor_public_id"("category" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_anchor_public_id"("category" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_attestation_public_id"("p_org_prefix" "text", "p_attestation_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_attestation_public_id"("p_org_prefix" "text", "p_attestation_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_attestation_public_id"("p_org_prefix" "text", "p_attestation_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_public_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_public_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_public_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_agents_for_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_agents_for_user"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_anchor_backlog_stats"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_anchor_backlog_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_anchor_backlog_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_anchor_backlog_stats"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_anchor_lineage"("p_public_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_anchor_lineage"("p_public_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_anchor_status_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_anchor_status_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_anchor_status_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_anchor_status_counts_fast"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_anchor_status_counts_fast"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_anchor_status_counts_fast"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_anchor_tx_stats"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_anchor_tx_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_anchor_type_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_anchor_type_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_anchor_type_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_caller_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_caller_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_caller_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_current_anchor_public_id"("p_public_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_anchor_public_id"("p_public_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_anchor_public_id"("p_public_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_distinct_record_types"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_distinct_record_types"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_distinct_record_types"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_edgar_shard_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_edgar_shard_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_edgar_shard_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_extraction_accuracy"("p_credential_type" "text", "p_org_id" "uuid", "p_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_extraction_accuracy"("p_credential_type" "text", "p_org_id" "uuid", "p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_extraction_accuracy"("p_credential_type" "text", "p_org_id" "uuid", "p_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_flag"("p_flag_key" "text", "p_default" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_flag"("p_flag_key" "text", "p_default" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_flag"("p_flag_key" "text", "p_default" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_credentials"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_credentials"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_credentials"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_org_anchor_stats"("p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_org_credit_summary"("p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_org_credit_summary"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_org_credit_summary"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_org_credit_summary"("p_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_org_members_public"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_org_members_public"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_org_members_public"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_org_subtree"("p_root_id" "uuid", "p_max_depth" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_org_subtree"("p_root_id" "uuid", "p_max_depth" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_org_subtree"("p_root_id" "uuid", "p_max_depth" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_parent_credit_rollup"("p_parent_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_parent_credit_rollup"("p_parent_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_parent_credit_rollup"("p_parent_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_parent_credit_rollup"("p_parent_org_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage_events" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage_events" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage_events" TO "service_role";



GRANT ALL ON TABLE "public"."billing_events" TO "anon";
GRANT ALL ON TABLE "public"."billing_events" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_events" TO "service_role";



GRANT ALL ON TABLE "public"."x402_payments" TO "anon";
GRANT ALL ON TABLE "public"."x402_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."x402_payments" TO "service_role";



GRANT ALL ON TABLE "public"."payment_ledger" TO "anon";
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."payment_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_ledger" TO "service_role";



GRANT ALL ON FUNCTION "public"."get_payment_ledger"("p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_payment_ledger"("p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_payment_ledger"("p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_pending_user_anchors"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_pending_user_anchors"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pending_user_anchors"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_pipeline_stats"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_pipeline_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pipeline_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_anchor"("p_public_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_anchor"("p_public_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_anchor"("p_public_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_issuer_registry"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_issuer_registry"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_issuer_registry"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_member_profile"("p_public_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_member_profile"("p_public_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_member_profile"("p_public_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_org_profile"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_org_profile"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_org_profile"("p_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_org_profiles"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_org_profiles"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_org_profiles"("p_org_id" "uuid", "p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text", "p_search" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text", "p_search" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_records_page"("p_page" integer, "p_page_size" integer, "p_source" "text", "p_record_type" "text", "p_anchor_status" "text", "p_search" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_records_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_records_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_records_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_template"("p_credential_type" "text", "p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_template"("p_credential_type" "text", "p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_template"("p_credential_type" "text", "p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_recent_cron_failures"("since_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_recent_cron_failures"("since_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_recent_cron_failures"("since_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_recent_cron_failures"("since_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_source_date_range"("p_source" "text", "p_date_field" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_source_date_range"("p_source" "text", "p_date_field" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_source_date_range"("p_source" "text", "p_date_field" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_table_bloat_stats"("table_names" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_table_bloat_stats"("table_names" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_table_bloat_stats"("table_names" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_table_bloat_stats"("table_names" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_treasury_stats"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_treasury_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_treasury_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_unembedded_public_records"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_unembedded_public_records"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_unembedded_public_records"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_anchor_stats"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_credits"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_credits"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_credits"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_monthly_anchor_count"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_org_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_org_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_org_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_org_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_org_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_org_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_auth_user_email_verified_org_join"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_auth_user_email_verified_org_join"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_auth_user_email_verified_org_join"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_org_usage"("p_org_id" "uuid", "p_quota_kind" "text", "p_delta" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_org_usage"("p_org_id" "uuid", "p_quota_kind" "text", "p_delta" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_org_usage"("p_org_id" "uuid", "p_quota_kind" "text", "p_delta" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."invite_member"("invitee_email" "text", "invitee_role" "public"."user_role", "target_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."invite_member"("invitee_email" "text", "invitee_role" "public"."user_role", "target_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."invite_member"("invitee_email" "text", "invitee_role" "public"."user_role", "target_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."invite_member"("inviter_user_id" "uuid", "invitee_email" "text", "invitee_role" "text", "target_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."invite_member"("inviter_user_id" "uuid", "invitee_email" "text", "invitee_role" "text", "target_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."invite_member"("inviter_user_id" "uuid", "invitee_email" "text", "invitee_role" "text", "target_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_current_user_platform_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_current_user_platform_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_current_user_platform_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_org_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_org_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_org_admin_of"("target_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_org_admin_of"("target_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_admin_of"("target_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_org_suspended"("p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_org_suspended"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_org_suspended"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_suspended"("p_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_user_verified"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_user_verified"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_user_verified"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."join_org_by_domain"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."join_org_by_domain"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_org_by_domain"("p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."link_public_records_to_anchors"("p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."link_public_records_to_anchors"("p_items" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."link_public_records_to_anchors"("p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."link_public_records_to_anchors"("p_items" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."link_recipient_on_signup"("p_user_id" "uuid", "p_email_hash" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."link_recipient_on_signup"("p_user_id" "uuid", "p_email_hash" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."link_recipient_on_signup"("p_user_id" "uuid", "p_email_hash" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."list_pending_resolution_anchors"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."list_pending_resolution_anchors"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_pending_resolution_anchors"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_pending_resolution_anchors_v2"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_pending_resolution_anchors_v2"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."list_pending_resolution_anchors_v2"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_pending_resolution_anchors_v2"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."log_switchboard_flag_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_switchboard_flag_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_switchboard_flag_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_verification_event"("p_public_id" "text", "p_method" "text", "p_result" "text", "p_fingerprint_provided" boolean, "p_user_agent" "text", "p_referrer" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."log_verification_event"("p_public_id" "text", "p_method" "text", "p_result" "text", "p_fingerprint_provided" boolean, "p_user_agent" "text", "p_referrer" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_verification_event"("p_public_id" "text", "p_method" "text", "p_result" "text", "p_fingerprint_provided" boolean, "p_user_agent" "text", "p_referrer" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."lookup_org_by_email_domain"("p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."lookup_org_by_email_domain"("p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lookup_org_by_email_domain"("p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_attestation_claim_modification"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_attestation_claim_modification"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_attestation_claim_modification"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_credential_type_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_credential_type_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_credential_type_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_direct_kyc_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_direct_kyc_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_direct_kyc_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_metadata_edit"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_metadata_edit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_metadata_edit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_metadata_edit_after_secured"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_metadata_edit_after_secured"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_metadata_edit_after_secured"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_anchor_status_transition"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_anchor_status_transition"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_anchor_status_transition"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_platform_admin_flag"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_platform_admin_flag"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_platform_admin_flag"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_privileged_profile_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_privileged_profile_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_privileged_profile_fields"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."recover_stuck_broadcasts"("p_stale_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recover_stuck_broadcasts"("p_stale_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."recover_stuck_broadcasts"("p_stale_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."recover_stuck_broadcasts"("p_stale_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_status_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_status_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_status_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_tx_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_tx_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_tx_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_type_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_type_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_cache_anchor_type_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_cache_by_source"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_cache_by_source"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_cache_by_source"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_cache_pipeline_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_cache_pipeline_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_cache_pipeline_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_cache_record_types"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_cache_record_types"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_cache_record_types"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_pipeline_dashboard_cache"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_pipeline_dashboard_cache"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_stats_cache"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_stats_cache"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_stats_cache"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_stats_materialized_views"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_stats_materialized_views"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_stats_materialized_views"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_audit_modification"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_audit_modification"() TO "anon";
GRANT ALL ON FUNCTION "public"."reject_audit_modification"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_audit_modification"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_advisory_lock"("lock_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_advisory_lock"("lock_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_claimed_rule_events"("p_event_ids" "uuid"[], "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_claimed_rule_events"("p_event_ids" "uuid"[], "p_error" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."release_claimed_rule_events"("p_event_ids" "uuid"[], "p_error" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_anchor_queue"("p_external_file_id" "text", "p_selected_anchor_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_anchor_queue"("p_external_file_id" "text", "p_selected_anchor_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_anchor_queue"("p_external_file_id" "text", "p_selected_anchor_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_anchor_queue_by_public_id"("p_external_file_id" "text", "p_selected_public_id" "text", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."revoke_anchor"("anchor_id" "uuid", "reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."revoke_anchor"("anchor_id" "uuid", "reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."revoke_anchor"("anchor_id" "uuid", "reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rls_auto_enable"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."roll_over_monthly_allocation"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."roll_over_monthly_allocation"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."roll_over_monthly_allocation"("p_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."sanitize_metadata_for_public"("p_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."sanitize_metadata_for_public"("p_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sanitize_metadata_for_public"("p_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_credential_embeddings"("p_org_id" "uuid", "p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_credential_embeddings"("p_org_id" "uuid", "p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_credential_embeddings"("p_org_id" "uuid", "p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_issuer_ground_truth"("p_issuer_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_issuer_ground_truth"("p_issuer_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_issuer_ground_truth"("p_issuer_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_organizations_public"("p_query" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_organizations_public"("p_query" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_organizations_public"("p_query" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_credential_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_credential_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_credential_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_credentials"("p_query" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_credentials"("p_query" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_credentials"("p_query" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_issuers"("p_query" "text", "p_limit" integer, "p_offset" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_issuers"("p_query" "text", "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_issuers"("p_query" "text", "p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_public_record_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_public_record_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_public_record_embeddings"("p_query_embedding" "public"."vector", "p_match_threshold" double precision, "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_anchor_version_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_anchor_version_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_anchor_version_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_onboarding_plan"("p_tier" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_onboarding_plan"("p_tier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_onboarding_plan"("p_tier" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_webhook_delivery_log_public_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_webhook_delivery_log_public_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_webhook_endpoint_public_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_webhook_endpoint_public_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."start_kyb_verification"("p_org_id" "uuid", "p_provider" "text", "p_reference_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."start_kyb_verification"("p_org_id" "uuid", "p_provider" "text", "p_reference_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_kyb_verification"("p_org_id" "uuid", "p_provider" "text", "p_reference_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."start_payment_grace"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."start_payment_grace"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_payment_grace"("p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_batch_anchors"("p_anchor_ids" "uuid"[], "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_batch_anchors"("p_anchor_ids" "uuid"[], "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_batch_anchors"("p_anchor_ids" "uuid"[], "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_batch_anchors"("p_anchor_ids" "uuid"[], "p_tx_id" "text", "p_block_height" bigint, "p_block_timestamp" timestamp with time zone, "p_merkle_root" "text", "p_batch_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."supersede_anchor"("old_anchor_id" "uuid", "new_fingerprint" "text", "reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."suspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."suspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."suspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."suspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_compliance_audits_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_compliance_audits_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_compliance_audits_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."try_advisory_lock"("lock_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."try_advisory_lock"("lock_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."unsuspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unsuspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."unsuspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unsuspend_suborg"("p_parent_org_id" "uuid", "p_sub_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_agents_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_agents_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_agents_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_attestation_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_attestation_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_attestation_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_credential_embeddings_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_credential_embeddings_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_credential_embeddings_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_grc_connections_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_grc_connections_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_grc_connections_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_institution_ground_truth_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_institution_ground_truth_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_institution_ground_truth_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_profile_onboarding"("p_role" "public"."user_role", "p_org_legal_name" "text", "p_org_display_name" "text", "p_org_domain" "text", "p_org_type" "text", "p_org_description" "text", "p_org_website_url" "text", "p_org_linkedin_url" "text", "p_org_twitter_url" "text", "p_org_location" "text", "p_org_ein_tax_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."update_profile_onboarding"("p_role" "public"."user_role", "p_org_legal_name" "text", "p_org_display_name" "text", "p_org_domain" "text", "p_org_type" "text", "p_org_description" "text", "p_org_website_url" "text", "p_org_linkedin_url" "text", "p_org_twitter_url" "text", "p_org_location" "text", "p_org_ein_tax_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_profile_onboarding"("p_role" "public"."user_role", "p_org_legal_name" "text", "p_org_display_name" "text", "p_org_domain" "text", "p_org_type" "text", "p_org_description" "text", "p_org_website_url" "text", "p_org_linkedin_url" "text", "p_org_twitter_url" "text", "p_org_location" "text", "p_org_ein_tax_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_public_records_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_public_records_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_public_records_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_review_queue_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_review_queue_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_review_queue_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."verify_anchors_rls_enabled"() TO "anon";
GRANT ALL ON FUNCTION "public"."verify_anchors_rls_enabled"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_anchors_rls_enabled"() TO "service_role";



GRANT ALL ON TABLE "public"."adobe_sign_webhook_nonces" TO "anon";
GRANT ALL ON TABLE "public"."adobe_sign_webhook_nonces" TO "authenticated";
GRANT ALL ON TABLE "public"."adobe_sign_webhook_nonces" TO "service_role";



GRANT ALL ON TABLE "public"."agents" TO "anon";
GRANT ALL ON TABLE "public"."agents" TO "authenticated";
GRANT ALL ON TABLE "public"."agents" TO "service_role";



GRANT ALL ON TABLE "public"."ai_credits" TO "anon";
GRANT ALL ON TABLE "public"."ai_credits" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_credits" TO "service_role";



GRANT ALL ON TABLE "public"."ai_reports" TO "anon";
GRANT ALL ON TABLE "public"."ai_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_reports" TO "service_role";



GRANT ALL ON TABLE "public"."anchor_chain_index" TO "anon";
GRANT ALL ON TABLE "public"."anchor_chain_index" TO "authenticated";
GRANT ALL ON TABLE "public"."anchor_chain_index" TO "service_role";



GRANT ALL ON TABLE "public"."anchor_proofs" TO "anon";
GRANT ALL ON TABLE "public"."anchor_proofs" TO "authenticated";
GRANT ALL ON TABLE "public"."anchor_proofs" TO "service_role";



GRANT ALL ON TABLE "public"."anchor_queue_resolutions" TO "anon";
GRANT ALL ON TABLE "public"."anchor_queue_resolutions" TO "authenticated";
GRANT ALL ON TABLE "public"."anchor_queue_resolutions" TO "service_role";



GRANT ALL ON TABLE "public"."anchor_recipients" TO "anon";
GRANT ALL ON TABLE "public"."anchor_recipients" TO "authenticated";
GRANT ALL ON TABLE "public"."anchor_recipients" TO "service_role";



GRANT ALL ON TABLE "public"."anchors" TO "anon";
GRANT ALL ON TABLE "public"."anchors" TO "authenticated";
GRANT ALL ON TABLE "public"."anchors" TO "service_role";



GRANT ALL ON TABLE "public"."api_key_usage" TO "anon";
GRANT ALL ON TABLE "public"."api_key_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."api_key_usage" TO "service_role";



GRANT ALL ON TABLE "public"."api_keys" TO "anon";
GRANT ALL ON TABLE "public"."api_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."api_keys" TO "service_role";



GRANT ALL ON TABLE "public"."ats_integrations" TO "anon";
GRANT ALL ON TABLE "public"."ats_integrations" TO "authenticated";
GRANT ALL ON TABLE "public"."ats_integrations" TO "service_role";



GRANT ALL ON TABLE "public"."ats_webhook_nonces" TO "anon";
GRANT ALL ON TABLE "public"."ats_webhook_nonces" TO "authenticated";
GRANT ALL ON TABLE "public"."ats_webhook_nonces" TO "service_role";



GRANT ALL ON TABLE "public"."attestation_evidence" TO "anon";
GRANT ALL ON TABLE "public"."attestation_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."attestation_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."attestations" TO "anon";
GRANT ALL ON TABLE "public"."attestations" TO "authenticated";
GRANT ALL ON TABLE "public"."attestations" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_events" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_events" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_events" TO "service_role";



GRANT ALL ON TABLE "public"."audit_events_archive" TO "anon";
GRANT ALL ON TABLE "public"."audit_events_archive" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_events_archive" TO "service_role";



GRANT ALL ON TABLE "public"."batch_verification_jobs" TO "anon";
GRANT ALL ON TABLE "public"."batch_verification_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."batch_verification_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."checkr_webhook_nonces" TO "anon";
GRANT ALL ON TABLE "public"."checkr_webhook_nonces" TO "authenticated";
GRANT ALL ON TABLE "public"."checkr_webhook_nonces" TO "service_role";



GRANT ALL ON TABLE "public"."cloud_logging_queue" TO "anon";
GRANT ALL ON TABLE "public"."cloud_logging_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."cloud_logging_queue" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cloud_logging_queue_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cloud_logging_queue_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cloud_logging_queue_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_audits" TO "anon";
GRANT ALL ON TABLE "public"."compliance_audits" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_audits" TO "service_role";



GRANT ALL ON TABLE "public"."compliance_scores" TO "anon";
GRANT ALL ON TABLE "public"."compliance_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_scores" TO "service_role";



GRANT ALL ON TABLE "public"."connector_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."connector_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."connector_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."credential_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."credential_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."credential_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."credential_portfolios" TO "anon";
GRANT ALL ON TABLE "public"."credential_portfolios" TO "authenticated";
GRANT ALL ON TABLE "public"."credential_portfolios" TO "service_role";



GRANT ALL ON TABLE "public"."credential_templates" TO "anon";
GRANT ALL ON TABLE "public"."credential_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."credential_templates" TO "service_role";



GRANT ALL ON TABLE "public"."credit_transactions" TO "anon";
GRANT ALL ON TABLE "public"."credit_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."credit_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."credits" TO "anon";
GRANT ALL ON TABLE "public"."credits" TO "authenticated";
GRANT ALL ON TABLE "public"."credits" TO "service_role";



GRANT ALL ON TABLE "public"."data_subject_requests" TO "anon";
GRANT ALL ON TABLE "public"."data_subject_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."data_subject_requests" TO "service_role";



GRANT ALL ON TABLE "public"."docusign_webhook_nonces" TO "anon";
GRANT ALL ON TABLE "public"."docusign_webhook_nonces" TO "authenticated";
GRANT ALL ON TABLE "public"."docusign_webhook_nonces" TO "service_role";



GRANT ALL ON TABLE "public"."drive_folder_path_cache" TO "anon";
GRANT ALL ON TABLE "public"."drive_folder_path_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."drive_folder_path_cache" TO "service_role";



GRANT ALL ON TABLE "public"."drive_revision_ledger" TO "anon";
GRANT ALL ON TABLE "public"."drive_revision_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."drive_revision_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."drive_webhook_nonces" TO "anon";
GRANT ALL ON TABLE "public"."drive_webhook_nonces" TO "authenticated";
GRANT ALL ON TABLE "public"."drive_webhook_nonces" TO "service_role";



GRANT ALL ON TABLE "public"."emergency_access_grants" TO "anon";
GRANT ALL ON TABLE "public"."emergency_access_grants" TO "authenticated";
GRANT ALL ON TABLE "public"."emergency_access_grants" TO "service_role";



GRANT ALL ON TABLE "public"."entitlements" TO "anon";
GRANT ALL ON TABLE "public"."entitlements" TO "authenticated";
GRANT ALL ON TABLE "public"."entitlements" TO "service_role";



GRANT ALL ON TABLE "public"."extraction_feedback" TO "anon";
GRANT ALL ON TABLE "public"."extraction_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."extraction_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."extraction_manifests" TO "anon";
GRANT ALL ON TABLE "public"."extraction_manifests" TO "authenticated";
GRANT ALL ON TABLE "public"."extraction_manifests" TO "service_role";



GRANT ALL ON TABLE "public"."ferpa_disclosure_log" TO "anon";
GRANT ALL ON TABLE "public"."ferpa_disclosure_log" TO "authenticated";
GRANT ALL ON TABLE "public"."ferpa_disclosure_log" TO "service_role";



GRANT ALL ON TABLE "public"."financial_reports" TO "anon";
GRANT ALL ON TABLE "public"."financial_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_reports" TO "service_role";



GRANT ALL ON TABLE "public"."freemail_domains" TO "anon";
GRANT ALL ON TABLE "public"."freemail_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."freemail_domains" TO "service_role";



GRANT ALL ON TABLE "public"."grc_connections" TO "anon";
GRANT ALL ON TABLE "public"."grc_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."grc_connections" TO "service_role";



GRANT ALL ON TABLE "public"."grc_sync_logs" TO "anon";
GRANT ALL ON TABLE "public"."grc_sync_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."grc_sync_logs" TO "service_role";



GRANT ALL ON TABLE "public"."institution_ground_truth" TO "anon";
GRANT ALL ON TABLE "public"."institution_ground_truth" TO "authenticated";
GRANT ALL ON TABLE "public"."institution_ground_truth" TO "service_role";



GRANT ALL ON TABLE "public"."integration_events" TO "anon";
GRANT ALL ON TABLE "public"."integration_events" TO "authenticated";
GRANT ALL ON TABLE "public"."integration_events" TO "service_role";



GRANT ALL ON TABLE "public"."integrity_scores" TO "anon";
GRANT ALL ON TABLE "public"."integrity_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."integrity_scores" TO "service_role";



GRANT ALL ON TABLE "public"."invitations" TO "anon";
GRANT ALL ON TABLE "public"."invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."invitations" TO "service_role";



GRANT ALL ON TABLE "public"."jurisdiction_rules" TO "anon";
GRANT ALL ON TABLE "public"."jurisdiction_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."jurisdiction_rules" TO "service_role";



GRANT ALL ON TABLE "public"."kyb_events" TO "anon";
GRANT ALL ON TABLE "public"."kyb_events" TO "authenticated";
GRANT ALL ON TABLE "public"."kyb_events" TO "service_role";



GRANT ALL ON TABLE "public"."kyb_webhook_nonces" TO "anon";
GRANT ALL ON TABLE "public"."kyb_webhook_nonces" TO "authenticated";
GRANT ALL ON TABLE "public"."kyb_webhook_nonces" TO "service_role";



GRANT ALL ON TABLE "public"."memberships" TO "anon";
GRANT ALL ON TABLE "public"."memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."memberships" TO "service_role";



GRANT ALL ON TABLE "public"."mv_anchor_status_counts" TO "service_role";



GRANT ALL ON TABLE "public"."public_records" TO "anon";
GRANT ALL ON TABLE "public"."public_records" TO "authenticated";
GRANT ALL ON TABLE "public"."public_records" TO "service_role";



GRANT ALL ON TABLE "public"."mv_public_records_source_counts" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."org_credit_allocations" TO "anon";
GRANT ALL ON TABLE "public"."org_credit_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."org_credit_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."org_credits" TO "anon";
GRANT ALL ON TABLE "public"."org_credits" TO "authenticated";
GRANT ALL ON TABLE "public"."org_credits" TO "service_role";



GRANT ALL ON TABLE "public"."org_daily_usage" TO "anon";
GRANT ALL ON TABLE "public"."org_daily_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."org_daily_usage" TO "service_role";



GRANT ALL ON TABLE "public"."org_integrations" TO "anon";
GRANT ALL ON TABLE "public"."org_integrations" TO "authenticated";
GRANT ALL ON TABLE "public"."org_integrations" TO "service_role";



GRANT ALL ON TABLE "public"."org_members" TO "anon";
GRANT ALL ON TABLE "public"."org_members" TO "authenticated";
GRANT ALL ON TABLE "public"."org_members" TO "service_role";



GRANT ALL ON TABLE "public"."org_monthly_allocation" TO "anon";
GRANT ALL ON TABLE "public"."org_monthly_allocation" TO "authenticated";
GRANT ALL ON TABLE "public"."org_monthly_allocation" TO "service_role";



GRANT ALL ON TABLE "public"."org_tier_entitlements" TO "anon";
GRANT ALL ON TABLE "public"."org_tier_entitlements" TO "authenticated";
GRANT ALL ON TABLE "public"."org_tier_entitlements" TO "service_role";



GRANT ALL ON TABLE "public"."organization_rule_events" TO "anon";
GRANT ALL ON TABLE "public"."organization_rule_events" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_rule_events" TO "service_role";



GRANT ALL ON TABLE "public"."organization_rule_executions" TO "anon";
GRANT ALL ON TABLE "public"."organization_rule_executions" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_rule_executions" TO "service_role";



GRANT ALL ON TABLE "public"."organization_rules" TO "anon";
GRANT ALL ON TABLE "public"."organization_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_rules" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."parent_split_tokens" TO "anon";
GRANT ALL ON TABLE "public"."parent_split_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."parent_split_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."payment_grace_periods" TO "anon";
GRANT ALL ON TABLE "public"."payment_grace_periods" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_grace_periods" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_dashboard_cache" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_dashboard_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_dashboard_cache" TO "service_role";



GRANT ALL ON TABLE "public"."plans" TO "anon";
GRANT ALL ON TABLE "public"."plans" TO "authenticated";
GRANT ALL ON TABLE "public"."plans" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."public_org_profiles" TO "anon";
GRANT ALL ON TABLE "public"."public_org_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."public_org_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."public_record_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."public_record_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."public_record_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."reconciliation_reports" TO "anon";
GRANT ALL ON TABLE "public"."reconciliation_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."reconciliation_reports" TO "service_role";



GRANT ALL ON TABLE "public"."report_artifacts" TO "anon";
GRANT ALL ON TABLE "public"."report_artifacts" TO "authenticated";
GRANT ALL ON TABLE "public"."report_artifacts" TO "service_role";



GRANT ALL ON TABLE "public"."reports" TO "anon";
GRANT ALL ON TABLE "public"."reports" TO "authenticated";
GRANT ALL ON TABLE "public"."reports" TO "service_role";



GRANT ALL ON TABLE "public"."review_queue_items" TO "anon";
GRANT ALL ON TABLE "public"."review_queue_items" TO "authenticated";
GRANT ALL ON TABLE "public"."review_queue_items" TO "service_role";



GRANT ALL ON TABLE "public"."rule_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."rule_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."rule_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."signatures" TO "anon";
GRANT ALL ON TABLE "public"."signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."signatures" TO "service_role";



GRANT ALL ON TABLE "public"."signing_certificates" TO "anon";
GRANT ALL ON TABLE "public"."signing_certificates" TO "authenticated";
GRANT ALL ON TABLE "public"."signing_certificates" TO "service_role";



GRANT ALL ON TABLE "public"."stats_cache" TO "anon";
GRANT ALL ON TABLE "public"."stats_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."stats_cache" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."switchboard_flag_history" TO "anon";
GRANT ALL ON TABLE "public"."switchboard_flag_history" TO "authenticated";
GRANT ALL ON TABLE "public"."switchboard_flag_history" TO "service_role";



GRANT ALL ON TABLE "public"."switchboard_flags" TO "anon";
GRANT ALL ON TABLE "public"."switchboard_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."switchboard_flags" TO "service_role";



GRANT ALL ON TABLE "public"."timestamp_tokens" TO "anon";
GRANT ALL ON TABLE "public"."timestamp_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."timestamp_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."treasury_alert_state" TO "anon";
GRANT ALL ON TABLE "public"."treasury_alert_state" TO "authenticated";
GRANT ALL ON TABLE "public"."treasury_alert_state" TO "service_role";



GRANT ALL ON TABLE "public"."treasury_cache" TO "anon";
GRANT ALL ON TABLE "public"."treasury_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."treasury_cache" TO "service_role";



GRANT ALL ON TABLE "public"."unified_credits" TO "anon";
GRANT ALL ON TABLE "public"."unified_credits" TO "authenticated";
GRANT ALL ON TABLE "public"."unified_credits" TO "service_role";



GRANT ALL ON TABLE "public"."user_notifications" TO "anon";
GRANT ALL ON TABLE "public"."user_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."user_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."v_slow_queries" TO "service_role";



GRANT ALL ON TABLE "public"."verification_events" TO "anon";
GRANT ALL ON TABLE "public"."verification_events" TO "authenticated";
GRANT ALL ON TABLE "public"."verification_events" TO "service_role";



GRANT ALL ON TABLE "public"."webhook_dead_letter_queue" TO "anon";
GRANT ALL ON TABLE "public"."webhook_dead_letter_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_dead_letter_queue" TO "service_role";



GRANT ALL ON TABLE "public"."webhook_delivery_logs" TO "anon";
GRANT ALL ON TABLE "public"."webhook_delivery_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_delivery_logs" TO "service_role";



GRANT ALL ON TABLE "public"."webhook_dlq" TO "anon";
GRANT ALL ON TABLE "public"."webhook_dlq" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_dlq" TO "service_role";



GRANT ALL ON TABLE "public"."webhook_endpoints" TO "anon";
GRANT ALL ON TABLE "public"."webhook_endpoints" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_endpoints" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







