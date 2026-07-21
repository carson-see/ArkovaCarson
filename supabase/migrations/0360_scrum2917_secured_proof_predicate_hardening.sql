-- 0360_scrum2917_secured_proof_predicate_hardening.sql
-- SCRUM-2917 (proof materializer) — the RULED "SECURED ⇒ proof complete"
-- predicate for enforce_secured_anchor_proof_complete() (the 0340 trigger
-- function). Compensating CREATE OR REPLACE per CLAUDE.md §1.2 — the 0340
-- file is NEVER edited.
--
-- PREFIX RESERVATION: 0360 confirmed by CTO ruling (Confluence 110198785) via
-- SCRUM-2979. Lands strictly AFTER 0358 (unmerged chain-rail PR #1552) and
-- 0359. FILE-ONLY THIS SLICE: authored but NOT applied anywhere (no prod, no
-- staging, no rig). Tier T3 (touches supabase/migrations/). DO NOT APPLY
-- until the RTE rig is stood up and an explicit go is given.
--
-- THE RULING (Confluence 110198785): when the GUC
-- `arkova.proof_enforce_secured_complete` = 'on', an anchor may transition
-- into SECURED only if its anchor_proofs row satisfies
--
--   (merkle_root IS NOT NULL AND proof_path IS NOT NULL)
--   OR (proof_completeness_class = 'direct_anchored'
--       AND op_return_payload IS NOT NULL)
--
-- Direct anchors (one tx per anchor, OP_RETURN commits the fingerprint
-- itself) honestly have EMPTY merkle_root/proof_path — a degenerate Merkle
-- branch must never be synthesized for them. But a bare
-- `proof_completeness_class = 'direct_anchored'` LABEL with a NULL
-- op_return_payload is FORBIDDEN (§1.4 forge risk): a label asserts a
-- classification, not evidence; only the on-chain payload bytes make a
-- direct anchor provable.
--
-- ONLY the SELECT ... INTO v_complete predicate and the exception message
-- change vs 0340. The GUC gate, transition-into-SECURED logic, SECURITY
-- DEFINER, SET search_path = public, and ERRCODE check_violation all stay
-- exactly as in 0340. The trigger wiring
-- (trg_anchors_proof_complete_on_secured) is untouched — it already EXECUTEs
-- this function by name.
--
-- ROLLBACK (restores the exact 0340 function body):
--   CREATE OR REPLACE FUNCTION public.enforce_secured_anchor_proof_complete()
--   RETURNS trigger
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   SET search_path = public
--   AS $fn$
--   DECLARE
--     v_enabled text;
--     v_complete boolean;
--   BEGIN
--     -- Only act on the PENDING/BROADCASTING/SUBMITTED → SECURED transition.
--     IF NEW.status IS DISTINCT FROM 'SECURED' THEN
--       RETURN NEW;
--     END IF;
--     IF TG_OP = 'UPDATE' AND OLD.status = 'SECURED' THEN
--       -- Already SECURED and staying SECURED (e.g. metadata/lifecycle touch):
--       -- do not re-litigate completeness here.
--       RETURN NEW;
--     END IF;
--
--     -- Gate: default OFF. Phase 2 sets this GUC to 'on' after backfill.
--     v_enabled := current_setting('arkova.proof_enforce_secured_complete', true);
--     IF v_enabled IS DISTINCT FROM 'on' THEN
--       RETURN NEW;
--     END IF;
--
--     SELECT (ap.merkle_root IS NOT NULL AND ap.proof_path IS NOT NULL)
--       INTO v_complete
--     FROM public.anchor_proofs ap
--     WHERE ap.anchor_id = NEW.id;
--
--     IF v_complete IS NOT TRUE THEN
--       RAISE EXCEPTION
--         'anchor % cannot be SECURED without a complete proof (anchor_proofs.merkle_root + proof_path)',
--         NEW.id
--         USING ERRCODE = 'check_violation';
--     END IF;
--
--     RETURN NEW;
--   END;
--   $fn$;
--   ALTER FUNCTION public.enforce_secured_anchor_proof_complete() OWNER TO postgres;
--   COMMENT ON FUNCTION public.enforce_secured_anchor_proof_complete() IS
--     'PROOF-02 (SCRUM-2335): gated invariant — when arkova.proof_enforce_secured_complete=''on'', an anchor may only become SECURED if its anchor_proofs row has merkle_root + proof_path. Default-off so the SCRUM-2471 back-catalogue backfill can run first.';
--   NOTIFY pgrst, 'reload schema';

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_secured_anchor_proof_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled text;
  v_complete boolean;
BEGIN
  -- Only act on the PENDING/BROADCASTING/SUBMITTED → SECURED transition.
  IF NEW.status IS DISTINCT FROM 'SECURED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'SECURED' THEN
    -- Already SECURED and staying SECURED (e.g. metadata/lifecycle touch):
    -- do not re-litigate completeness here.
    RETURN NEW;
  END IF;

  -- Gate: default OFF. Phase 2 sets this GUC to 'on' after backfill.
  v_enabled := current_setting('arkova.proof_enforce_secured_complete', true);
  IF v_enabled IS DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;

  -- RULED predicate (CTO ruling, Confluence 110198785 / SCRUM-2917):
  -- batch shape (merkle_root + proof_path) OR honest direct anchor
  -- (direct_anchored class WITH the on-chain OP_RETURN payload bytes).
  -- A bare direct_anchored label with NULL op_return_payload is NOT proof.
  SELECT (
      (ap.merkle_root IS NOT NULL AND ap.proof_path IS NOT NULL)
      OR (ap.proof_completeness_class = 'direct_anchored'
          AND ap.op_return_payload IS NOT NULL)
    )
    INTO v_complete
  FROM public.anchor_proofs ap
  WHERE ap.anchor_id = NEW.id;

  IF v_complete IS NOT TRUE THEN
    RAISE EXCEPTION
      'anchor % cannot be SECURED without a complete proof: need anchor_proofs.merkle_root + proof_path, or proof_completeness_class = ''direct_anchored'' WITH op_return_payload — a bare proof_completeness_class label is not proof',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_secured_anchor_proof_complete() OWNER TO postgres;

COMMENT ON FUNCTION public.enforce_secured_anchor_proof_complete() IS
  'PROOF-02 (SCRUM-2335) hardened by SCRUM-2917 (CTO ruling 110198785): gated invariant — when arkova.proof_enforce_secured_complete=''on'', an anchor may only become SECURED if its anchor_proofs row has merkle_root + proof_path (batch shape), OR proof_completeness_class = ''direct_anchored'' AND op_return_payload IS NOT NULL (honest direct anchor; empty Merkle fields are its truthful state). A bare direct_anchored label with NULL op_return_payload is rejected (§1.4 forge risk). Default-off so the SCRUM-2471 back-catalogue backfill can run first.';

-- Reload PostgREST schema cache (function body change; keeps §4 convention).
NOTIFY pgrst, 'reload schema';

COMMIT;
