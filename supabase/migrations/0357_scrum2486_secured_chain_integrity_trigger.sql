-- 0357_scrum2486_secured_chain_integrity_trigger.sql
-- SCRUM-2486 — "SECURED ⇒ on-chain proof present" enforcement trigger.
--
-- =============================================================================
-- STATUS: FILE-ONLY / PRE-SOAK / NEVER-APPLIED — Sprint-4 T3 deferred work.
--   Per the 3.25 ART decision, SCRUM-2486 is a P0 launch-blocker whose four ACs
--   (this CHECK/trigger + a hash-invariance backfill gate + a frozen-fixture
--   evidence_package_hash test + an importer-can't-set-SECURED-outside-the-
--   state-machine guard) are 0/4 met and are net-new, never-soaked T3 work.
--   This file authors ONLY the schema-integrity half (the trigger) so the design
--   is reviewable now; it is NOT applied to prod or any rig this window, and it
--   does NOT close the ticket. It carries to Sprint-4 with its own 48h T3 soak.
--   Numeric prefix 0357 is the next free above the soak-locked 0354 band and the
--   Lane-1 reservation table below; see supabase/migrations/agents.md.
-- =============================================================================
--
-- WHAT IT ENFORCES:
--   An anchor MUST NOT reach status = 'SECURED' unless it carries a real on-chain
--   receipt: chain_tx_id IS NOT NULL AND chain_timestamp IS NOT NULL. SECURED is
--   the terminal "this document is provably anchored" state (§1.4: SECURED is
--   worker-only via service_role), and a SECURED row with a NULL chain_tx_id is a
--   data-integrity violation — it asserts an anchor the chain never received.
--
-- WHY A TRIGGER, NOT A CHECK CONSTRAINT:
--   The invariant is a *conditional* one (only when status = 'SECURED') and the
--   two-phase fail-safe rollout below references a session/database GUC, neither
--   of which a table CHECK constraint can express cleanly across the ~2.97M-row
--   back catalogue. It is therefore a BEFORE-UPDATE/INSERT trigger on anchors,
--   mirroring the 0340 proof-completeness trigger (SCRUM-2335) exactly.
--
-- TWO-PHASE / FAIL-SAFE ROLLOUT (mirrors 0340):
--   The invariant is GATED behind a session/database GUC
--   `arkova.secured_enforce_chain_present` that defaults OFF. Phase 1 (this
--   migration): trigger function + wiring, enforcement INERT — zero behavior
--   change, no back-catalogue rejection. Phase 2 (Sprint-4, after the AC-2
--   backfill audit confirms every existing SECURED anchor already has a
--   chain_tx_id — the historical 2.97M all do, since the worker only sets SECURED
--   after broadcast — and after a clean 48h T3 staging soak): flip the GUC on with
--   NO further migration:  ALTER DATABASE <db> SET arkova.secured_enforce_chain_present = 'on';
--   Reversible the same way (RESET).
--
-- COMPANION AC WORK STILL OWED IN SPRINT-4 (NOT in this file — needs the rig):
--   * AC-2 hash-invariance backfill GATE: a one-shot audit query proving no
--     existing SECURED row violates the invariant BEFORE Phase-2 flip (block the
--     flip if any row does). Authored + run against the isolated 0357 rig.
--   * AC-3 frozen-fixture evidence_package_hash test: a deterministic vitest that
--     pins the serialized proof/evidence-package hash for a known anchor so a
--     future serializer change that would silently alter a SECURED anchor's
--     evidence hash fails CI. (evidence_package_hash is a derived/serialized
--     value, not an anchors column — the test lives in worker test-land.)
--   * AC-4 importer guard: assert the DocuSign/Drive connector import path can
--     NEVER write status='SECURED' directly (only PENDING/BROADCASTING), so the
--     only path to SECURED remains the worker state machine post-broadcast.
--   These are tracked on SCRUM-2486 and are its Sprint-4 T3 deliverables.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_anchors_chain_present_on_secured ON public.anchors;
--   DROP FUNCTION IF EXISTS public.enforce_secured_anchor_chain_present();
--   -- (If Phase 2 was applied) reset the GUC:
--   --   ALTER DATABASE <db> RESET arkova.secured_enforce_chain_present;

BEGIN;

-- ---------------------------------------------------------------------------
-- "SECURED ⇒ chain receipt present" enforcement trigger (GATED, default inert).
-- ---------------------------------------------------------------------------
-- Fires when an anchor transitions INTO 'SECURED'. When the GUC
-- `arkova.secured_enforce_chain_present` is 'on', it requires the anchor to
-- carry a non-NULL chain_tx_id AND chain_timestamp. Default OFF so Phase 1 is a
-- pure no-op until the Sprint-4 backfill audit + soak clear the Phase-2 flip.
CREATE OR REPLACE FUNCTION public.enforce_secured_anchor_chain_present()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled text;
BEGIN
  -- Only act on the transition INTO 'SECURED'.
  IF NEW.status IS DISTINCT FROM 'SECURED' THEN
    RETURN NEW;
  END IF;

  -- Already SECURED and staying SECURED (metadata/lifecycle touch): do not
  -- re-litigate — an existing SECURED row keeps its receipt; only the moment of
  -- entry into SECURED is gated.
  IF TG_OP = 'UPDATE' AND OLD.status = 'SECURED' THEN
    RETURN NEW;
  END IF;

  -- Gate: default OFF. Phase 2 (Sprint-4) sets this GUC to 'on' after the
  -- back-catalogue backfill audit + a clean T3 staging soak.
  v_enabled := current_setting('arkova.secured_enforce_chain_present', true);
  IF v_enabled IS DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.chain_tx_id IS NULL OR NEW.chain_timestamp IS NULL THEN
    RAISE EXCEPTION
      'anchor % cannot be SECURED without an on-chain receipt (chain_tx_id + chain_timestamp)',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_secured_anchor_chain_present() OWNER TO postgres;

-- BEFORE trigger so a violating transition is rejected before the row is
-- written (INSERT covers a service_role insert straight to SECURED; UPDATE
-- covers the normal BROADCASTING/SUBMITTED → SECURED lifecycle move).
DROP TRIGGER IF EXISTS trg_anchors_chain_present_on_secured ON public.anchors;
CREATE TRIGGER trg_anchors_chain_present_on_secured
  BEFORE INSERT OR UPDATE OF status ON public.anchors
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_secured_anchor_chain_present();

COMMENT ON FUNCTION public.enforce_secured_anchor_chain_present() IS
  'SCRUM-2486: gated (GUC arkova.secured_enforce_chain_present, default off) integrity trigger — an anchor may not enter SECURED without a non-NULL chain_tx_id + chain_timestamp. Phase 1 inert; Phase 2 flips the GUC after backfill audit + T3 soak. Pre-soak, not yet applied to prod.';

COMMIT;
