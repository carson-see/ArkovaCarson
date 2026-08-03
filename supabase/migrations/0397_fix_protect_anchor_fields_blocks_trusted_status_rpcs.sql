-- 0397 — second half of the 0393/0395 defect class: protect_anchor_fields also
-- blocks trusted SECURITY DEFINER admin RPCs, and 0395 never touched it.
--
-- ROLLBACK:
--   CREATE OR REPLACE FUNCTION public.protect_anchor_status_transition()
--     RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
--   AS $rollback$
--   DECLARE
--     caller_role text;
--   BEGIN
--     caller_role := get_caller_role();
--     IF caller_role = 'service_role' THEN RETURN NEW; END IF;
--     IF TG_OP = 'INSERT' THEN
--       IF NEW.status != 'PENDING' THEN
--         RAISE EXCEPTION 'New anchors must start in PENDING status' USING ERRCODE = 'insufficient_privilege';
--       END IF;
--       RETURN NEW;
--     END IF;
--     IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
--       RAISE EXCEPTION 'Cannot change anchor owner' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
--       RAISE EXCEPTION 'Cannot set status to SECURED directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.status != 'SUBMITTED' AND NEW.status = 'SUBMITTED' THEN
--       RAISE EXCEPTION 'Cannot set status to SUBMITTED directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.status != 'BROADCASTING' AND NEW.status = 'BROADCASTING' THEN
--       RAISE EXCEPTION 'Cannot set status to BROADCASTING directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.status IS DISTINCT FROM NEW.status THEN
--       RAISE EXCEPTION 'Only the system can change anchor status (current: %, requested: %)', OLD.status, NEW.status
--         USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
--        OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
--        OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp
--        OR OLD.chain_confirmations IS DISTINCT FROM NEW.chain_confirmations THEN
--       RAISE EXCEPTION 'Cannot modify chain data directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.revocation_tx_id IS DISTINCT FROM NEW.revocation_tx_id
--        OR OLD.revocation_block_height IS DISTINCT FROM NEW.revocation_block_height THEN
--       RAISE EXCEPTION 'Cannot modify revocation chain data directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
--       RAISE EXCEPTION 'Cannot modify legal_hold directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.parent_anchor_id IS DISTINCT FROM NEW.parent_anchor_id THEN
--       RAISE EXCEPTION 'Cannot modify parent_anchor_id directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF OLD.version_number IS DISTINCT FROM NEW.version_number THEN
--       RAISE EXCEPTION 'Cannot modify version_number directly' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     IF (OLD.status IN ('SECURED', 'SUBMITTED', 'BROADCASTING', 'REVOKED'))
--        AND OLD.description IS DISTINCT FROM NEW.description THEN
--       RAISE EXCEPTION 'Cannot modify description after anchor is secured' USING ERRCODE = 'insufficient_privilege';
--     END IF;
--     RETURN NEW;
--   END; $rollback$;
--   ALTER FUNCTION public.protect_anchor_status_transition() OWNER TO postgres;
--   NOTIFY pgrst, 'reload schema';
--   -- NOTE: rolling back reinstates the defect described below for
--   -- revoke_anchor / supersede_anchor / resolve_anchor_queue(_by_public_id).
--
-- =============================================================================
-- THE DEFECT — a second trigger 0395 never checked
--
-- 0393 added `trg_restrict_org_admin_folder_update`, and 0395 hotfixed it to
-- stop blocking trusted SECURITY DEFINER admin RPCs (revoke_anchor etc.) by
-- gating on current_user. 0395's own header even NAMED the other three
-- browser-callable SECURITY DEFINER anchor updaters with "same exposure" —
-- supersede_anchor, resolve_anchor_queue, resolve_anchor_queue_by_public_id —
-- but that session verified the fix with a narrow current_user probe against
-- prod, not a full RLS run, and never noticed a SECOND, older, unrelated
-- trigger on the same table with the identical defect.
--
-- `protect_anchor_fields` (function protect_anchor_status_transition, baseline,
-- predates 0393 entirely) has a single escape hatch: get_caller_role() =
-- 'service_role'. get_caller_role() reads request.jwt.claim.role /
-- request.jwt.claims — PostgREST-set GUCs reflecting the ORIGINAL caller's JWT.
-- SECURITY DEFINER changes current_user for the duration of the function (and
-- anything it invokes, including triggers fired by its own DML), but it does
-- NOT change these request-scoped GUCs — the exact mechanism 0395's header
-- already explains for get_caller_role() specifically. So inside revoke_anchor
-- (SECURITY DEFINER, owner postgres, invoked by an org admin's own JWT),
-- get_caller_role() still returns 'authenticated', never 'service_role' — and
-- protect_anchor_fields' generic "OLD.status IS DISTINCT FROM NEW.status" catch-
-- all (there is no per-RPC or per-current_user carve-out) rejects the UPDATE
-- with 42501 before 0395's trigger is ever reached (BEFORE ROW triggers on the
-- same table fire in NAME order — 'protect_anchor_fields' < 'trg_restrict_org_
-- admin_folder_update' — so this is the FIRST guard revoke_anchor's UPDATE
-- meets, independent of 0393/0395 ever having existed).
--
-- Same mechanism, same UPDATE-anchors-SET-status shape, in
-- supersede_anchor (-> SUPERSEDED) and resolve_anchor_queue /
-- resolve_anchor_queue_by_public_id (PENDING_RESOLUTION -> PENDING for the
-- kept anchor, PENDING_RESOLUTION -> REVOKED for rejected siblings) — all four
-- are SECURITY DEFINER, owner postgres, invoked from the browser under the
-- caller's own JWT, with their OWN independent ORG_ADMIN + org-match + business-
-- rule authorization already completed before the UPDATE. All four have been
-- blocked by this trigger since it was introduced, independent of 0393/0395.
--
-- This was not caught earlier because tests/rls/folders.test.ts's revoke_anchor
-- regression test (added same-day, for 0393/0395) is the first RLS-level test
-- in this repo to ever exercise any of these four RPCs end-to-end — confirmed
-- by grep: no other test file references revoke_anchor, supersede_anchor, or
-- resolve_anchor_queue at the database layer. PR #1938's CI (an unrelated CE-
-- registry-link PR that happened to merge main after 0395 landed) is what
-- surfaced it: a fresh `supabase db reset` runs every migration and the full
-- trigger chain, unlike whatever narrower current_user probe validated 0395.
--
-- Production impact, verified directly (not inferred): prod's anchors table
-- has exactly ONE row with status = 'REVOKED', ever, out of ~2.97M anchors,
-- dated 2026-04-01 — four months old — with an audit_events actor_id different
-- from the anchor's owner (so not even a same-user self-revoke). At that
-- volume this is consistent with the RPC path having essentially never been
-- exercised by a real admin; that lone row is far more likely a service_role/
-- worker-side write (already exempted by this trigger's existing check) than
-- proof the RPC path ever worked. Not proof of zero prior attempts — proof
-- this has not been meaningfully usable.
--
-- THE FIX — narrow, not a blanket bypass
--
-- Only the generic "Only the system can change anchor status" catch-all gets a
-- current_user exemption, using the exact signal 0395 already established and
-- verified empirically: a direct PostgREST table write executes as
-- 'authenticated'/'anon'; a write from inside a trusted SECURITY DEFINER
-- function owned by postgres executes as 'postgres'.
--
-- SECURITY INVOKER, not DEFINER — this is the part the first draft of this
-- migration got wrong, caught only by running the regression suite against a
-- real local `supabase db reset`, not by reading the SQL. protect_anchor_
-- status_transition was SECURITY DEFINER in baseline, and the first draft
-- left that alone while adding the current_user check below — but SECURITY
-- DEFINER makes current_user equal the FUNCTION's own owner (postgres) for
-- the entire duration of its execution, for EVERY caller, unconditionally. A
-- current_user check inside a SECURITY DEFINER function can never see
-- 'authenticated' or 'anon' — the guard would go silently false for every
-- caller, including ordinary direct client writes, disabling this trigger's
-- enforcement entirely rather than narrowing it. Empirical proof: with the
-- function still DEFINER, a direct authenticated client UPDATE setting
-- status SECURED -> REVOKED on the caller's own anchor returned HTTP 200
-- with the row genuinely changed server-side — a full bypass, strictly worse
-- than 0393's original over-broad block. A throwaway SECURITY INVOKER probe
-- (`SELECT current_user, session_user, get_caller_role()`) called through
-- the same authenticated client confirmed current_user genuinely is
-- 'authenticated' for that exact request (session_user is 'authenticator',
-- the pooled connection role PostgREST reuses; current_user is what it SET
-- ROLEs to per request) — proving the signal itself is sound and the defect
-- was solely the DEFINER/INVOKER choice, not the current_user mechanism 0395
-- already validated. This is the identical correction 0395 already made to
-- the sibling folder trigger, restated here because it did not carry over:
-- SECURITY INVOKER is safe for a trigger function that reads only NEW/OLD/
-- TG_OP and calls get_caller_role() (itself independently SECURITY DEFINER,
-- so its own JWT-claim read is unaffected either way) — this function does
-- no table I/O of its own, so it needs no elevated privilege, and INVOKER is
-- what makes current_user reflect the ACTUAL caller instead of always
-- reading back whatever the function owner happens to be.
--
-- Deliberately NOT exempted, for ANY current_user, including postgres —
-- unconditional regardless of caller:
--   * owner change (OLD.user_id IS DISTINCT FROM NEW.user_id)
--   * direct-set to SECURED / SUBMITTED / BROADCASTING (the three specific
--     forgery guards — no code path anywhere needs a trusted RPC to fake these)
--   * chain_tx_id / chain_block_height / chain_timestamp / chain_confirmations
--     tamper (chain-of-custody data — the core anchoring integrity guarantee)
--   * revocation_tx_id / revocation_block_height tamper
--   * legal_hold tamper
--   * parent_anchor_id / version_number tamper
--   * description-after-secured tamper
-- None of revoke_anchor / supersede_anchor / resolve_anchor_queue(_by_public_id)
-- ever need to touch any of these columns, and none of the transitions they
-- perform (-> REVOKED from any status; -> SUPERSEDED from any status except
-- REVOKED/SUPERSEDED; PENDING_RESOLUTION -> PENDING) require the direct-set
-- guards above. So even a future buggy or compromised SECURITY DEFINER RPC
-- still cannot forge SECURED/SUBMITTED/BROADCASTING or touch chain data,
-- legal_hold, ownership, or lineage through this trigger — only the generic
-- status-change catch-all trusts current_user, exactly mirroring the scope of
-- what 0395 already proved safe for the folder trigger, applied here to the
-- one check that actually needs it instead of the whole function.
--
-- SECOND, INDEPENDENT BUG found while writing the regression tests for this
-- migration (not fixed here — see 0398): supersede_anchor, resolve_anchor_
-- queue, resolve_anchor_queue_by_public_id, and 0367's 4-arg service_role
-- overloads of the latter two all INSERT INTO audit_events an `actor_email`
-- column that was dropped by migration 0170 — every one of their audit
-- writes has been throwing 42703 (undefined_column) since 0170, independent
-- of this trigger entirely. revoke_anchor was never affected: it is the only
-- one of the four that never referenced the dropped column.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.protect_anchor_status_transition()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public
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

  -- Only this generic catch-all trusts current_user: a direct PostgREST write
  -- executes as authenticated/anon; a write from inside a trusted postgres-
  -- owned SECURITY DEFINER RPC (revoke_anchor, supersede_anchor,
  -- resolve_anchor_queue, resolve_anchor_queue_by_public_id) executes as
  -- postgres and has already completed its own ORG_ADMIN + org-match +
  -- business-rule authorization before reaching this UPDATE.
  IF OLD.status IS DISTINCT FROM NEW.status
     AND current_user IN ('authenticated', 'anon')
  THEN
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

ALTER FUNCTION public.protect_anchor_status_transition() OWNER TO postgres;

COMMENT ON FUNCTION public.protect_anchor_status_transition() IS
  'protect_anchor_fields trigger body (baseline, hotfixed by 0397): guards anchor status transitions and chain-of-custody columns. SECURITY INVOKER (was DEFINER in baseline — DEFINER would make current_user always read back the function owner, breaking the check below for every caller) so only the generic status-change catch-all trusts current_user (postgres = inside a trusted SECURITY DEFINER RPC that already authorized itself, e.g. revoke_anchor/supersede_anchor/resolve_anchor_queue(_by_public_id)); every other guard (owner, SECURED/SUBMITTED/BROADCASTING direct-set, chain data, revocation chain data, legal_hold, lineage, description-after-secured) remains unconditional for every caller.';

NOTIFY pgrst, 'reload schema';
