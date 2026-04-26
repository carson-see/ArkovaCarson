-- SCRUM-1261 (R1-7): re-affirm beta no-quota policy from migration 0084.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Migration 0084_beta_unlimited_quotas.sql (2026-03 timeframe) overrode
-- check_anchor_quota() to RETURN NULL — the no-op required by
-- memory/feedback_no_credit_limits_beta.md ("NO credit limits during beta").
-- Migration 0093_atomic_quota_enforcement.sql shipped 6 hours later and
-- silently re-introduced FOR-UPDATE-locked enforcement (Forensic 8/8 audit
-- documented this on 2026-04-25). Prod was reverted manually to RETURN NULL
-- at some point but the repo migration ledger still ends with 0093 — meaning
-- `npx supabase db reset` rebuilds the broken enforcement and a fresh dev
-- environment hits `P0002 Quota exceeded` on the 4th anchor.
--
-- This migration permanently locks the no-op state in the repo so the
-- intended beta policy survives `db reset`. The R0-7 CI lint
-- (scripts/ci/feedback-rules/no-credit-limits-beta.ts, SCRUM-1253) already
-- blocks new migrations that surface the P0002 quota-error pattern; this
-- migration completes the picture by ensuring a clean DB start matches
-- CI's expectation.
--
-- IDEMPOTENT: prod already returns NULL; this is a CREATE OR REPLACE no-op
-- against prod and a meaningful rebuild against fresh dev databases.
--
-- ROLLBACK:
--   When beta ends and billing is re-enabled, write a NEW migration that
--   explicitly mentions superseding 0084 + 0266 + this memory file. Do
--   NOT modify this file or 0084 — the historical chain is the audit trail
--   that next time someone (or some agent) tries to re-introduce quota
--   enforcement, it lands on top of the documented no-op decision rather
--   than silently re-overriding it.
--
-- VERIFY AFTER APPLY:
--   SELECT check_anchor_quota();  -- should return NULL
--   SELECT bulk_create_anchors('[
--     {"fingerprint":"0000...0001","filename":"t","fileSize":1}
--   ]'::jsonb);  -- should NOT raise P0002 even on free-tier orgs

CREATE OR REPLACE FUNCTION public.check_anchor_quota()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
BEGIN
  -- Beta: all quotas disabled per memory/feedback_no_credit_limits_beta.md.
  -- bulk_create_anchors() reads NULL → IF quota_remaining IS NOT NULL guards
  -- short-circuit → no quota enforcement.
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.check_anchor_quota() IS
  'SCRUM-1261 (R1-7) lock: re-affirms 0084 beta no-quota policy that 0093 silently overrode. Memory: feedback_no_credit_limits_beta.md. CI: scripts/ci/feedback-rules/no-credit-limits-beta.ts (R0-7).';
