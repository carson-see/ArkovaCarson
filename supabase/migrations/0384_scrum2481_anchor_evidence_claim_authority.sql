-- 0384_scrum2481_anchor_evidence_claim_authority.sql
-- SCRUM-2481 — server-side evidence-level trust enforcement, DB half.
--
-- WHAT THE API HALF MISSED:
--   The API-route guard (`stripClientUnassertableEvidenceClaims`, this PR)
--   closes `POST /api/v1/anchor`. It cannot close the shorter path: the
--   browser writes `anchors` DIRECTLY over PostgREST
--   (`src/components/anchor/SecureDocumentDialog.tsx`,
--   `src/components/organization/IssueCredentialForm.tsx` — both
--   `supabase.from('anchors').insert({ ...validated, metadata })`, validated
--   only by client-side Zod). `anchors_insert_own` constrains `user_id`,
--   `status` and `org_id` and NOTHING about `metadata`; there is no CHECK on
--   the column and no BEFORE INSERT trigger that inspects it. So a free
--   account plus its own JWT could insert
--   `metadata = {"verification_level":"issuer_anchored", ...}`, let the
--   nightly drain SECURE it, and serve the forged green issuer-authenticated
--   badge (plus the shareable off-platform badge) out of `get_public_anchor`,
--   which projects `verification_level` as a top-level key to `anon`. That is
--   a LOWER bar than the API-key path the route guard closes. Reproduced
--   against a local stack before this file existed:
--     INSERT ... metadata '{"verification_level":"issuer_anchored"}'  -> persisted
--     UPDATE ... metadata || '{"verification_level":"source_signed"}' -> persisted
--     UPDATE ... fingerprint_source = 'document_bytes'                -> persisted
--
--   `prevent_metadata_edit_after_secured` only blocks metadata edits on
--   NON-PENDING rows, so even an anchor created through the now-guarded API
--   route could be upgraded with one PATCH during its PENDING window.
--
-- WHAT THIS ENFORCES:
--   1. `metadata.verification_level` may not be SET or CHANGED to a
--      server-attested level (`issuer_anchored`, `source_signed`) by any
--      caller other than `service_role`. These are the two tiers
--      `isIssuerAuthenticated` (`src/lib/sourceProvenance.ts`) renders as
--      issuer-authenticated, and NO writer in the platform can prove either:
--      the Credly and Accredible adapters cap at `account_linked` even when
--      the provider returns a `proof` block, and URL import hardcodes
--      `captured_url`. There is therefore no legitimate producer to break.
--   2. `fingerprint_source` (0376) is immutable for non-`service_role`
--      callers. Nothing in the product updates it — the browser sets it once
--      at INSERT and `bulk_create_anchors` computes it server-side at INSERT —
--      so a change is unambiguously a caller rewriting its own evidence class
--      (`issuer_record_attestation` -> `document_bytes`) after the fact, which
--      `protect_anchor_status_transition` does not guard and
--      `prevent_metadata_edit_after_secured` does not cover (that trigger
--      reads `metadata`/`description` only).
--
-- STRIP THE LEVEL, REFUSE THE COLUMN — the asymmetry is deliberate:
--   `verification_level` lives in the free-form `metadata` blob whose writers'
--   established contract is "persist what is understood, ignore the rest"
--   (`anchor-submit.ts` allow-list; `bulk_create_anchors` copies the blob
--   wholesale, so a RAISE there would surface as an opaque per-row
--   `insert_failed` and lose the whole CSV row over one ignorable key).
--   Stripping keeps the anchor and drops only the claim the server cannot
--   stand behind. `fingerprint_source` is a first-class CHECK-constrained
--   column with NO legitimate update writer at all, so a change is refused
--   outright, exactly like the sibling guards in
--   `protect_anchor_status_transition`.
--
-- INSERTS OF `fingerprint_source` ARE NOT BLOCKED. The browser legitimately
--   sets `document_bytes` at insert time (SecureDocumentDialog) and
--   `bulk_create_anchors` sets the class from its `fingerprintProvided`
--   boolean. Per 0376's own header the server can never verify that a
--   client-computed fingerprint came from real file bytes (§1.6 puts hashing
--   on the device), so an insert-time block would assert a guarantee we do
--   not have. What IS closed is post-hoc REWRITING, which no honest client
--   does.
--
-- WHY A TRIGGER AND NOT RLS: an RLS `WITH CHECK` cannot compare NEW to OLD on
--   UPDATE for the "introduced or changed" test, and cannot strip a key —
--   only accept or reject the whole row. Mirrors 0357/0340 trigger shape.
--
-- TRIGGER ORDER: BEFORE triggers fire in name order.
--   `trg_strip_unassertable_evidence_claims` sorts AFTER
--   `trg_prevent_metadata_edit`, deliberately: a post-SECURED metadata edit
--   still hits that trigger's existing RAISE first, so this file changes no
--   existing error behavior — it only adds coverage for the INSERT and the
--   PENDING window.
--
-- LOCKING: CREATE TRIGGER takes a brief ACCESS EXCLUSIVE lock on `anchors`
--   (catalog-only, no row scan and no rewrite of the ~2.97M-row table). No
--   backfill: existing rows are NOT audited or rewritten here — see the PR's
--   residual-risk note, which hands the "does any forged level already exist"
--   query to RTE. This changes ingest only.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_strip_unassertable_evidence_claims ON public.anchors;
--   DROP FUNCTION IF EXISTS public.enforce_anchor_evidence_claim_authority();
--   NOTIFY pgrst, 'reload schema';
--   -- Reverting restores the pre-0384 behavior exactly: any authenticated
--   -- user can mint a forged issuer-authenticated badge again.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_anchor_evidence_claim_authority() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
DECLARE
  v_new_level text;
BEGIN
  -- The worker is the only attesting writer (§1.4: SECURED is worker-only via
  -- service_role). Everything below applies to browser/PostgREST callers and
  -- to SECURITY DEFINER RPCs invoked under an end-user JWT.
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.fingerprint_source IS DISTINCT FROM OLD.fingerprint_source THEN
    RAISE EXCEPTION 'Cannot change fingerprint_source after creation (evidence class is fixed at insert)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_new_level := NEW.metadata ->> 'verification_level';
  IF v_new_level IS NULL OR v_new_level NOT IN ('issuer_anchored', 'source_signed') THEN
    RETURN NEW;
  END IF;

  -- Carried through unchanged from an earlier service_role write: an unrelated
  -- owner edit must not silently DOWNGRADE a level the server did attest.
  IF TG_OP = 'UPDATE' AND OLD.metadata ->> 'verification_level' IS NOT DISTINCT FROM v_new_level THEN
    RETURN NEW;
  END IF;

  NEW.metadata := NEW.metadata - 'verification_level';
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_anchor_evidence_claim_authority() OWNER TO postgres;

COMMENT ON FUNCTION public.enforce_anchor_evidence_claim_authority() IS
  'SCRUM-2481 DB half. Non-service_role callers may not introduce or change metadata.verification_level = issuer_anchored/source_signed (stripped, anchor still created) and may not change fingerprint_source at all (refused). Closes the direct-PostgREST forgery of the public issuer-authenticated badge that the API-route guard cannot see.';

DROP TRIGGER IF EXISTS trg_strip_unassertable_evidence_claims ON public.anchors;
CREATE TRIGGER trg_strip_unassertable_evidence_claims
  BEFORE INSERT OR UPDATE OF metadata, fingerprint_source ON public.anchors
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_anchor_evidence_claim_authority();

NOTIFY pgrst, 'reload schema';

COMMIT;
