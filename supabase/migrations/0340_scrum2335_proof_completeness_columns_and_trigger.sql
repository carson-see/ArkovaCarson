-- 0340_scrum2335_proof_completeness_columns_and_trigger.sql
-- PROOF-02 (SCRUM-2335) — proof-bundle completeness columns on anchor_proofs
-- plus a GATED "SECURED ⇒ proof complete" enforcement trigger.
--
-- Train D proof-integrity foundation. This migration is the schema half of
-- the PROOF-01 contract (Confluence 81330178): it adds the columns a full
-- two-layer proof bundle needs (block header / block hash / OP_RETURN
-- payload / integer leaf index / schema version) and a trigger that, once
-- enabled, refuses to let an anchor reach SECURED without a complete proof
-- row (merkle_root + proof_path present).
--
-- WHY A TRIGGER, NOT A CHECK: the invariant references `anchors.status`
-- (a DIFFERENT table from `anchor_proofs`, and a moving value), and a CHECK
-- constraint cannot subquery another table. The rule is therefore a
-- constraint trigger on `anchors`.
--
-- TWO-PHASE / FAIL-SAFE ROLLOUT: the ~2.97M anchors already SECURED have no
-- app-tree branch yet (PROOF-01 §4 back-catalog) and FIX-1 (SCRUM-2471) only
-- starts persisting branches for NEW batches. Enforcing immediately would
-- reject legitimate pre-existing rows on any status touch. So enforcement is
-- GATED behind a session/database GUC `arkova.proof_enforce_secured_complete`
-- that defaults OFF. Phase 1 (this migration): columns + trigger function +
-- trigger wiring, enforcement INERT. Phase 2 (after the backfill job
-- SCRUM-2471 has populated branches for existing SECURED anchors, validated
-- on staging): `ALTER DATABASE ... SET arkova.proof_enforce_secured_complete
-- = 'on';` flips enforcement on with NO further migration. Reversible the
-- same way.
--
-- NOTE: the new columns are additive + nullable, so this does not rewrite
-- existing rows and the verify API (§1.8 frozen schema) stays additive.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_anchors_proof_complete_on_secured ON public.anchors;
--   DROP FUNCTION IF EXISTS public.enforce_secured_anchor_proof_complete();
--   ALTER TABLE public.anchor_proofs
--     DROP COLUMN IF EXISTS block_header,
--     DROP COLUMN IF EXISTS block_hash,
--     DROP COLUMN IF EXISTS op_return_payload,
--     DROP COLUMN IF EXISTS merkle_index,
--     DROP COLUMN IF EXISTS proof_schema_version;
--   -- (If Phase 2 was applied) reset the GUC:
--   --   ALTER DATABASE <db> RESET arkova.proof_enforce_secured_complete;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Proof-bundle completeness columns (additive, nullable).
-- ---------------------------------------------------------------------------
ALTER TABLE public.anchor_proofs
  ADD COLUMN IF NOT EXISTS block_header bytea,
  ADD COLUMN IF NOT EXISTS block_hash text,
  ADD COLUMN IF NOT EXISTS op_return_payload bytea,
  ADD COLUMN IF NOT EXISTS merkle_index integer,
  ADD COLUMN IF NOT EXISTS proof_schema_version smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.anchor_proofs.block_header IS
  'Layer-2 bitcoin-tree: the 80-byte block header (bytea at rest, 160-hex on the wire). PROOF-01 on_chain.block_header.';
COMMENT ON COLUMN public.anchor_proofs.block_hash IS
  'Layer-2 bitcoin-tree: the confirmed block hash (64-hex). PROOF-01 on_chain.block_hash.';
COMMENT ON COLUMN public.anchor_proofs.op_return_payload IS
  'Layer-2 bind: raw OP_RETURN payload = "ARKV"(4B)+version(1B)+app_merkle_root(32B). PROOF-01 on_chain.op_return_payload.';
COMMENT ON COLUMN public.anchor_proofs.merkle_index IS
  'Layer-1 app-tree: integer leaf index of this document in the batch tree (Electrum/gettxoutproof-compatible). PROOF-01 app_tree.merkle_index. Enables the CVE-2012-2459 structural verify guard.';
COMMENT ON COLUMN public.anchor_proofs.proof_schema_version IS
  'PROOF-01 proof_schema_version. 1 = current (plain double-SHA256 app-tree, no domain tags, matches on-chain roots). Future tagged-hash format (RFC-6962) would bump this and is gated behind the OP_RETURN version-byte decision.';

-- ---------------------------------------------------------------------------
-- 2. "SECURED ⇒ proof complete" enforcement trigger (GATED, default inert).
-- ---------------------------------------------------------------------------
-- Fires when an anchor transitions INTO 'SECURED'. When the GUC
-- `arkova.proof_enforce_secured_complete` is 'on', it requires a matching
-- anchor_proofs row whose merkle_root AND proof_path are both populated.
-- Pipeline/public-record anchors (which already persist branches via
-- publicRecordAnchor.ts) and customer anchors (post-FIX-1) both satisfy this;
-- the gate stays OFF until the SCRUM-2471 backfill has filled the back
-- catalogue so legitimate historical rows are never rejected.
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

  SELECT (ap.merkle_root IS NOT NULL AND ap.proof_path IS NOT NULL)
    INTO v_complete
  FROM public.anchor_proofs ap
  WHERE ap.anchor_id = NEW.id;

  IF v_complete IS NOT TRUE THEN
    RAISE EXCEPTION
      'anchor % cannot be SECURED without a complete proof (anchor_proofs.merkle_root + proof_path)',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_secured_anchor_proof_complete() OWNER TO postgres;

COMMENT ON FUNCTION public.enforce_secured_anchor_proof_complete() IS
  'PROOF-02 (SCRUM-2335): gated invariant — when arkova.proof_enforce_secured_complete=''on'', an anchor may only become SECURED if its anchor_proofs row has merkle_root + proof_path. Default-off so the SCRUM-2471 back-catalogue backfill can run first.';

DROP TRIGGER IF EXISTS trg_anchors_proof_complete_on_secured ON public.anchors;
CREATE TRIGGER trg_anchors_proof_complete_on_secured
  BEFORE INSERT OR UPDATE OF status ON public.anchors
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_secured_anchor_proof_complete();

-- Reload PostgREST schema cache so the new columns are visible to the API.
NOTIFY pgrst, 'reload schema';

COMMIT;
