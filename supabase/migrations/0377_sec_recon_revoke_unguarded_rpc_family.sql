-- 0377_sec_recon_revoke_unguarded_rpc_family.sql
-- SEC-RECON follow-up to #1652 / 0364 — revoke anon/authenticated EXECUTE from
--   the SECURITY DEFINER RPC family that 0364 missed, and drop the legacy
--   vulnerable invite_member(uuid,text,text,uuid) overload.
--
-- =============================================================================
-- STATUS: FILE-ONLY / PRE-SOAK / NEVER-APPLIED. Authored for review only. NOT
--   applied to prod or any rig in this window. T3 (touches privilege grants
--   on chain-lifecycle + credit mutators + drops a function overload).
--   Numeric prefix 0377 is the next free above main head 0366: open PRs claim
--   up to 0376 (#1741), 0375 (#1739), 0370 (#1730), 0368 (#1727), 0364 (#1652),
--   0362 (#1618), 0359/0360 (#1615) — all verified via `gh pr view --json
--   files` against every open PR this session; see supabase/migrations/agents.md.
-- =============================================================================
--
-- WHAT IT REVOKES AND WHY — verified against LIVE PROD (vzwyaatejekddvltxyye)
-- via pg_get_functiondef + information_schema/pg_proc grant introspection this
-- session (not inferred from prior claims):
--
--   1. public.submit_batch_anchors(uuid[], text, bigint, timestamptz, text, text)
--      Flips PENDING/BROADCASTING anchors to SUBMITTED and writes
--      chain_tx_id/chain_block_height/chain_timestamp FROM CALLER-SUPPLIED
--      ARGUMENTS, with no auth.uid() / caller-identity check at all. Anon or
--      authenticated could forge a Bitcoin chain receipt for ANY anchor by id.
--      Worst of the set. Legitimate caller: services/worker/src/jobs/
--      batch-anchor.ts (reconcile + primary + legacy-fallback submit paths),
--      via the shared service_role `db` client (services/worker/src/utils/db.ts,
--      createClient(..., config.supabaseServiceKey)). service_role keeps EXECUTE.
--
--   2. public.batch_insert_anchors(jsonb)
--      Inserts anchors rows taking user_id/org_id straight out of the JSON
--      payload — no cross-check against auth.uid(). Its correctly-guarded
--      sibling, bulk_create_anchors(jsonb), uses auth.uid() + check_anchor_quota()
--      (studied as the reference pattern; left untouched — anon/authenticated
--      staying granted on it is safe because it self-authorizes internally and
--      simply raises 'Profile not found' for anon). Legitimate caller:
--      services/worker/src/jobs/publicRecordAnchor.ts (service_role `db`,
--      default client when no override is passed — routes/cron.ts calls
--      processPublicRecordAnchoring() with zero args).
--
--   3. public.allocate_monthly_credits()
--      Zero-arg, zero-auth. Loops every `credits` row with cycle_end <= now()
--      and reallocates platform-wide. Anon-callable = anyone can trigger a
--      platform-wide credit reallocation on demand. Legitimate caller:
--      services/worker/src/jobs/credit-expiry.ts (service_role `db`).
--
--   4. public.deduct_ai_credits(uuid, uuid, integer)
--      Debits ai_credits for an arbitrary org_id/user_id with no ownership
--      check. Legitimate caller: services/worker/src/ai/cost-tracker.ts
--      (service_role `db`).
--
--   5. public.deduct_unified_credits(uuid, uuid, integer)
--      Debits unified_credits for an arbitrary org_id/user_id with no ownership
--      check. Legitimate callers: services/worker/src/middleware/
--      paymentTierRouter.ts + services/worker/src/api/v1/credits.ts
--      (both service_role `db`).
--
--   6. public.roll_over_monthly_allocation(uuid)
--      Closes an org's current monthly allocation period and opens the next
--      one (including the rolled-over carry balance) for an arbitrary
--      p_org_id with no ownership check. Legitimate caller:
--      services/worker/src/jobs/monthly-allocation-rollover.ts (service_role
--      `dbUntyped`, same underlying client).
--
-- All six above are called EXCLUSIVELY through the worker's shared service_role
-- Supabase client (services/worker/src/utils/db.ts:
--   createClient<TypeSafeDatabase>(dbUrl, config.supabaseServiceKey, ...))
-- — grep -rn across src/ and services/worker/src/ this session found no
-- authenticated-role (browser/frontend) call site for any of the six. Revoking
-- anon/authenticated EXECUTE does not touch service_role and is a safe,
-- non-breaking change for the worker.
--
-- WHAT IT DROPS AND WHY:
--   public.invite_member(uuid, text, text, uuid) — the LEGACY 4-arg overload.
--   Takes `inviter_user_id` as a caller-supplied uuid NEVER compared to
--   auth.uid(), `invitee_role` as unchecked `text` (vs. the safe overload's
--   `user_role` enum), and lacks the SEC-RECON-8 "block inviting as
--   ORG_ADMIN" guard that public.invite_member(text, user_role, uuid) has.
--   Both overloads were anon/authenticated-EXECUTE-granted, so an attacker
--   could call the 4-arg form directly via PostgREST, name any inviter_user_id
--   (impersonating an org admin without being one), and invite a new member
--   as 'ORG_ADMIN' directly — a privilege-escalation vector the safe overload
--   explicitly blocks.
--
--   Confirmed no caller depends on the 4-arg overload: grep -a -rn
--   "invite_member" src/ services/ this session found exactly one call site,
--   src/hooks/useInviteMember.ts:72, which invokes
--   `(supabase as any).rpc('invite_member', { invitee_email, invitee_role,
--   target_org_id })` — three NAMED arguments matching
--   invite_member(text, user_role, uuid) param-for-param
--   (invitee_email/invitee_role/target_org_id). PostgREST resolves named-arg
--   RPC calls to the overload whose parameter names match; dropping the 4-arg
--   overload (whose params are inviter_user_id/invitee_email/invitee_role/
--   target_org_id) cannot change that resolution. The safe 3-arg overload is
--   NOT touched by this migration — it keeps its existing anon/authenticated
--   grant (it self-authorizes via auth.uid() + the ORG_ADMIN + SEC-RECON-8
--   guards already in its body).
--
-- ADDITIONAL UNGUARDED SECURITY DEFINER FUNCTIONS FOUND THIS SESSION (NOT
-- revoked here — reported for follow-up, this family "was missed once
-- already" per CLAUDE.md §0.1 note on 0364):
--   CRITICAL (same forge-the-chain-record class as submit_batch_anchors):
--     finalize_public_record_anchor_batch(jsonb,text,bigint,timestamptz,text,text),
--     drain_submitted_to_secured_for_tx (both overloads — flips SUBMITTED to
--     SECURED keyed only on caller-supplied chain_tx_id/block fields),
--     bulk_promote_confirmed(text[]).
--   HIGH (tenant/identity boundary bypass):
--     auto_associate_profile_to_org_by_email_domain(uuid,text) — arbitrary
--       p_user_id, explicitly re-escalates to service_role via set_config()
--       inside the body;
--     link_recipient_on_signup(uuid,text) — arbitrary p_user_id claims any
--       unclaimed anchor_recipients row by email hash;
--     archive_old_audit_events(integer) — anon-callable with retention_days=0
--       wipes the audit trail on demand;
--     clear_payment_grace(uuid) / start_payment_grace(uuid) — arbitrary-org
--       billing-state mutation;
--     enqueue_rule_event(...) / record_msgraph_nonce_and_enqueue(...) —
--       anon-only grant, arbitrary org_id, can trigger org automation rules
--       for orgs the caller does not belong to;
--     claim_pending_anchors / claim_next_job / claim_due_org_queue_runs /
--       claim_pending_rule_events — worker queue-claim RPCs anon/authenticated
--       (or anon-only) callable; could stall the anchoring/queue pipeline.
--   MEDIUM: increment_org_usage(uuid,text,bigint) (arbitrary org_id + signed
--     delta — quota corruption/evasion), search_credential_embeddings(uuid,...)
--     (cross-tenant org_id, no ownership check — anchor_id/similarity leak),
--     link_public_records_to_anchors(jsonb) (no ownership check on anchor_id),
--     get_pending_user_anchors(integer) (returns raw internal anchors.id
--     globally — banned per CLAUDE.md "Common Mistakes": only public_id may
--     be exposed).
--   Full sweep query + evidence in the PR description. Recommend a dedicated
--   follow-up ticket — this file intentionally stays scoped to the six named
--   functions + invite_member to keep worker call-site verification tractable
--   and the T3 soak bounded.
--
-- ROLLBACK:
--   -- Restore the pre-0377 grant state on the six revoked functions:
--   GRANT EXECUTE ON FUNCTION public.submit_batch_anchors(uuid[], text, bigint, timestamp with time zone, text, text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.batch_insert_anchors(jsonb) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.allocate_monthly_credits() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.deduct_ai_credits(uuid, uuid, integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.deduct_unified_credits(uuid, uuid, integer) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.roll_over_monthly_allocation(uuid) TO anon, authenticated;
--   -- Restore the dropped invite_member(uuid,text,text,uuid) overload exactly as it existed in prod:
--   CREATE OR REPLACE FUNCTION public.invite_member(inviter_user_id uuid, invitee_email text, invitee_role text, target_org_id uuid)
--    RETURNS uuid
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE
--     v_inviter_role text;
--     v_invitation_id uuid;
--   BEGIN
--     SELECT role INTO v_inviter_role
--     FROM profiles
--     WHERE user_id = inviter_user_id AND org_id = target_org_id;
--     IF v_inviter_role IS NULL OR v_inviter_role != 'ORG_ADMIN' THEN
--       RAISE EXCEPTION 'Only organization admins can invite members';
--     END IF;
--     INSERT INTO invitations (org_id, invited_by, email, role, status)
--     VALUES (target_org_id, inviter_user_id, invitee_email, invitee_role, 'PENDING')
--     RETURNING id INTO v_invitation_id;
--     INSERT INTO audit_events (actor_id, org_id, action, details)
--     VALUES (
--       inviter_user_id,
--       target_org_id,
--       'invite_member',
--       format('Invitation %s created for role %s', v_invitation_id, invitee_role)
--     );
--     RETURN v_invitation_id;
--   END;
--   $function$;
--   GRANT EXECUTE ON FUNCTION public.invite_member(uuid, text, text, uuid) TO anon, authenticated, service_role;
--   NOTIFY pgrst, 'reload schema';
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Revoke anon/authenticated EXECUTE on the six unguarded SECURITY DEFINER
-- mutators. service_role keeps EXECUTE — the worker (via services/worker/src/
-- utils/db.ts's service-role client) is the sole legitimate caller for all six.
-- REVOKE FROM PUBLIC is defensive: it strips the implicit default-PUBLIC grant
-- so the function cannot be re-exposed via a role that inherits PUBLIC.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.submit_batch_anchors(uuid[], text, bigint, timestamp with time zone, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_batch_anchors(uuid[], text, bigint, timestamp with time zone, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.batch_insert_anchors(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.batch_insert_anchors(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.allocate_monthly_credits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_monthly_credits() TO service_role;

REVOKE ALL ON FUNCTION public.deduct_ai_credits(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_ai_credits(uuid, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.deduct_unified_credits(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_unified_credits(uuid, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.roll_over_monthly_allocation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.roll_over_monthly_allocation(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Drop the vulnerable legacy invite_member(uuid,text,text,uuid) overload.
-- The safe 3-arg overload — invite_member(text, user_role, uuid), which
-- self-authorizes via auth.uid() + ORG_ADMIN check + the SEC-RECON-8
-- "cannot invite as ORG_ADMIN" guard — is untouched by this statement (it is
-- a distinct function with a distinct signature; PostgreSQL function identity
-- includes the parameter list).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.invite_member(uuid, text, text, uuid);

-- Reload the PostgREST schema cache so the revoked/dropped privileges take
-- effect on the API surface immediately (grants + function catalog are cached
-- by PostgREST).
NOTIFY pgrst, 'reload schema';

COMMIT;
