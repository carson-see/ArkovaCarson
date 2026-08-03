-- 0394_sec_ce_provenance_key_authority.sql
-- CE provenance key authority — DB-layer write guard for the anon-projected
-- registry provenance keys. Pre-existing gap confirmed 2026-08-03 during the
-- #1938 adversarial review.
--
-- THE HOLE:
--   `anchors.metadata.registry_url` is served RAW to anonymous callers by
--   `get_public_anchor`'s explicit allow-list (0362, restored by 0383, value-
--   gated by 0385's `private.public_url_or_null`) and rendered on the public
--   verify page as the "Registry reference" link. But NOTHING at the DB layer
--   restricts who may WRITE it: `anchors_insert_own` constrains only
--   `user_id`/`status`/`org_id` (nothing about `metadata`), and 0384's
--   `enforce_anchor_evidence_claim_authority` guards only
--   `metadata.verification_level` and `fingerprint_source`. So any
--   authenticated user could insert an anchor over PostgREST with
--   `metadata.registry_url = 'https://attacker.example/phish'`, let the
--   nightly drain SECURE it, and have arkova.ai's public verify page link an
--   anonymous verifier straight to the attacker's page as an apparent
--   Credential Engine registry reference. `public_url_or_null` strips the
--   query string/fragment and scans for PII — it has NO domain allow-list, so
--   an attacker origin passes it clean. The frontend's `sanitizeSourceUrl()`
--   checks scheme only. Reproduced against a local stack before this file
--   existed (isolated PG 15 container, non-service_role caller):
--     INSERT ... metadata '{"registry_url":"https://attacker.example/phish"}' -> persisted
--     UPDATE ... metadata || '{"registry_url":"https://attacker.example/x"}'  -> persisted (PENDING window)
--
-- WHAT THIS ENFORCES:
--   The service-stamped CE provenance key family in `anchors.metadata` is
--   READ-ONLY for every caller other than `service_role`:
--     registry_url        — CE registry provenance link, projected to anon (0362)
--     ce_envelope_sha256  — CE envelope integrity fingerprint, projected to anon (0362)
--     ce_registry_url     — route-side source `registry_url` is derived from
--                           (`credentials-ctdl-registry-anchor.ts`)
--     ce_registry_ctid    — drives the ce-registry-drift job's outbound fetch
--                           (pattern-gated + SSRF-hardened, but a forged ctid
--                           still poisons drift findings/dedup)
--   On INSERT by a non-service_role caller, present keys are STRIPPED. On
--   UPDATE, each key is REVERTED to its OLD value (introduction is stripped,
--   tamper and deletion are undone) — so a legitimately service-stamped value
--   survives an owner's unrelated PENDING-window metadata edit instead of
--   being destroyed, and the registry_url/ce_envelope_sha256 pair can never
--   be split by a client write.
--
--   The ONLY legitimate writers are service_role code paths:
--   `credentials-ctdl-registry-anchor.ts` (stamps ce_registry_ctid /
--   ce_registry_url) and `credential-source-import.ts` (stamps registry_url /
--   ce_envelope_sha256 together, per its own always-set/unset-together
--   contract). The browser CTDL import dialog calls those worker routes over
--   `workerFetch` — it never writes these keys over PostgREST. There is no
--   legitimate producer to break. `ce_record_name` is deliberately NOT
--   guarded: it is a display label read back only by the stamping route, never
--   projected to anon and never job-driving.
--
-- STRIP/REVERT, NEVER RAISE — same asymmetry rationale as 0384: these keys
--   live in the free-form metadata blob whose writers' contract is "persist
--   what is understood, ignore the rest" (`bulk_create_anchors` copies the
--   blob wholesale, so a RAISE would surface as an opaque per-row
--   `insert_failed` and lose a whole CSV row over one ignorable key).
--   Stripping keeps the anchor and drops only the claim the server cannot
--   stand behind.
--
-- WHY A SEPARATE FUNCTION + TRIGGER (not CREATE OR REPLACE of 0384's):
--   `get_public_anchor`'s history shows wholesale redefinition is this
--   schema's dominant failure mode (0376 silently reverted 0356+0362).
--   Extending 0384's function would put its verification_level semantics at
--   clobber risk from any future editor of THIS file, and vice versa. A
--   sibling trigger keeps each guard's audit trail and rollback independent.
--   src/tests/sec-ce-provenance-key-authority.test.ts asserts these
--   invariants against the HIGHEST-numbered migration redefining this
--   function, so a future stale-file redefinition fails CI.
--
-- TRIGGER ORDER: BEFORE triggers fire in name order.
--   trg_prevent_metadata_edit < trg_strip_unassertable_evidence_claims (0384)
--   < trg_strip_unattested_ce_provenance_keys (this file). A post-SECURED
--   metadata edit still hits the existing RAISE first and 0384's strip runs
--   unchanged — this file adds coverage for INSERT and the PENDING window
--   without altering any existing error path.
--
-- DEFENSE-IN-DEPTH CONSIDERED AND DECLINED: a domain allow-list inside the
--   `get_public_anchor` projection was considered and deliberately NOT shipped
--   here — it would require redefining the function (the exact clobber-prone
--   surface above; 0385 must stay the latest redefiner for the PII contract
--   test), and with this trigger the write path is closed for every
--   non-service_role caller while service_role writers construct the URL from
--   the validated CE registry base. Residual risk is rows forged BEFORE this
--   trigger exists; at prod-apply time RTE audits with:
--     SELECT public_id, metadata->>'registry_url'
--     FROM anchors
--     WHERE deleted_at IS NULL
--       AND metadata ? 'registry_url'
--       AND metadata->>'registry_url' NOT LIKE 'https://credentialengineregistry.org/%';
--   and hands any hit to the security lane for takedown.
--
-- LOCKING: CREATE TRIGGER takes a brief ACCESS EXCLUSIVE lock on `anchors`
--   (catalog-only, no row scan and no rewrite of the ~2.97M-row table). No
--   backfill: existing rows are audited at apply time (query above), not
--   rewritten here. This changes ingest only.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_strip_unattested_ce_provenance_keys ON public.anchors;
--   DROP FUNCTION IF EXISTS public.enforce_ce_provenance_key_authority();
--   NOTIFY pgrst, 'reload schema';
--   -- Reverting restores the pre-0394 behavior exactly: any authenticated
--   -- user can again point the public verify page's Registry reference link
--   -- at an arbitrary URL.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_ce_provenance_key_authority() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
DECLARE
  v_guarded constant text[] := ARRAY['registry_url', 'ce_envelope_sha256', 'ce_registry_url', 'ce_registry_ctid']::text[];
  v_key text;
  v_meta jsonb;
BEGIN
  -- The CTDL importer routes are the only attesting writers (§1.4). Everything
  -- below applies to browser/PostgREST callers and to SECURITY DEFINER RPCs
  -- invoked under an end-user JWT.
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_meta := COALESCE(NEW.metadata, '{}'::jsonb);

  FOREACH v_key IN ARRAY v_guarded LOOP
    IF TG_OP = 'UPDATE' AND OLD.metadata ? v_key THEN
      -- Revert tamper/deletion to the service-stamped value, type-preserving.
      IF v_meta -> v_key IS DISTINCT FROM OLD.metadata -> v_key THEN
        v_meta := jsonb_set(v_meta, ARRAY[v_key], OLD.metadata -> v_key, true);
      END IF;
    ELSE
      v_meta := v_meta - v_key;
    END IF;
  END LOOP;

  -- Keep an explicit NULL metadata as NULL when the guard changed nothing.
  IF v_meta IS DISTINCT FROM NEW.metadata AND NOT (NEW.metadata IS NULL AND v_meta = '{}'::jsonb) THEN
    NEW.metadata := v_meta;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_ce_provenance_key_authority() OWNER TO postgres;

COMMENT ON FUNCTION public.enforce_ce_provenance_key_authority() IS
  'CE provenance key authority (0394). Non-service_role callers may not introduce, change, or delete the service-stamped CE provenance keys in anchors.metadata (registry_url, ce_envelope_sha256, ce_registry_url, ce_registry_ctid): stripped on INSERT, reverted to OLD on UPDATE, anchor still written. Closes the direct-PostgREST forgery of the public verify page''s Registry reference link.';

DROP TRIGGER IF EXISTS trg_strip_unattested_ce_provenance_keys ON public.anchors;
CREATE TRIGGER trg_strip_unattested_ce_provenance_keys
  BEFORE INSERT OR UPDATE OF metadata ON public.anchors
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ce_provenance_key_authority();

NOTIFY pgrst, 'reload schema';

COMMIT;
