-- 0423_sec_docusign_metadata_key_write_authority.sql
-- DocuSign metadata key write authority — DB-layer write guard for the
-- DocuSign provenance key family in `anchors.metadata`. CTO Decision Record
-- ruling R1 (docs/staging/docusign-bilateral-2026-08/CTO-DECISION-RECORD.md,
-- security Finding 2). PR-1 of the DocuSign bilateral coverage sequence —
-- must land before the record-deep-links work (PR-3) renders these fields as
-- a trust signal on the public/record UI.
--
-- THE HOLE:
--   `services/worker/src/constants/connectorFingerprint.ts` documents its own
--   gap: "the metadata blob is org-writable on some legacy paths (e.g.
--   bulk_create_anchors persists client metadata verbatim)". `anchors_insert_own`
--   constrains only `user_id`/`status`/`org_id` — nothing about `metadata` —
--   and neither 0384's evidence-claim guard nor 0394's CE-provenance guard
--   covers the DocuSign key family. So today, any authenticated caller can:
--     - call `bulk_create_anchors(jsonb)` (SECURITY DEFINER, self-authorizes
--       via auth.uid(), copies its input metadata blob wholesale — see 0376),
--       or
--     - INSERT/UPDATE `anchors` directly over PostgREST (the same "legacy
--       path" 0384 closed for `verification_level` and 0394 closed for the CE
--       registry keys)
--   with `metadata = {"connector_source":"docusign","account_id":"<fake>",
--   "envelope_id":"<fake>","_signers":[...]}`. The nightly drain SECUREs it
--   like any other anchor, and the record UI (this cycle's DocuSign deep-link
--   work, R7) would render forged "Verified via DocuSign" links and signer
--   rows sourced entirely from attacker-supplied strings — provenance fraud,
--   exactly what Constitution §1.5 / R-7 forbid.
--
-- WHAT THIS ENFORCES:
--   The server-stamped DocuSign provenance key family in `anchors.metadata`
--   is READ-ONLY for every caller other than `service_role`:
--     connector_source       — gates isConnectorFetchSource() (§1.6A evidence
--                               class) and the record UI's DocuSign badge.
--                               Unconditionally guarded.
--     connector_artifact_id  — FK-shaped pointer into connector_artifact,
--                               written at drain time (jobs/connector-artifact-drain.ts).
--                               Unconditionally guarded.
--     account_id             — DocuSign account GUID; composes the account
--                               deep link (R7, docusignLinks.ts). Guarded
--                               ONLY when the row claims DocuSign provenance
--                               — see CONDITIONAL GUARDING below.
--     envelope_id            — DocuSign envelope GUID; composes the envelope
--                               deep link (R7) and drives the (org, envelope)
--                               dedup guard (docusign-anchor-reconciliation.ts).
--                               Same conditional guarding as account_id.
--     _signers                — pseudonymous signer rows (R6): recipient GUID
--                               + status only, never name/email. Unconditionally
--                               guarded.
--     _docusign_env           — selects the apps.docusign.com vs apps-d.
--                               deep-link base (R7). Unconditionally guarded.
--     _direction               — inbound/outbound classification (R4) — held
--                               here as foundation; not yet written by any
--                               shipped path (F1/PR-4 is flag-OFF).
--                               Unconditionally guarded.
--     _sending_account_id      — server-resolved owning-account comparator
--                               for R4's inbound/outbound classification.
--                               Unconditionally guarded.
--
--   On INSERT by a non-service_role caller, present keys are STRIPPED. On
--   UPDATE, each key is REVERTED to its OLD value (introduction is stripped,
--   tamper and deletion are undone) — so a legitimately service-stamped value
--   survives an owner's unrelated PENDING-window metadata edit instead of
--   being destroyed. Identical strip/revert shape to 0394.
--
--   CONDITIONAL GUARDING OF account_id / envelope_id: unlike the other 6
--   keys, `account_id` and `envelope_id` are generic names that also occur
--   legitimately in NON-DocuSign metadata — `SecureDocumentDialog.tsx`
--   spreads AI-extracted document fields top-level into `metadata`
--   (`{ ...acceptedFields }`, keyed by the extraction template's own field
--   names — a financial-document template can plausibly extract an
--   "Account ID" field), and `IssueCredentialForm.tsx` persists arbitrary
--   org-template field keys the same way. Guarding these two unconditionally
--   would silently strip that legitimate, unrelated data with no error on a
--   document that has nothing to do with DocuSign — correct-looking but
--   wrong. So they are guarded only when the row also claims DocuSign
--   provenance: `v_claims_docusign` is true when either the caller's own
--   payload or the row's existing (OLD) state carries `connector_source` at
--   all (checking OLD too closes the gap where a caller omits
--   `connector_source` from an UPDATE payload specifically to launder a real
--   row's `account_id`/`envelope_id` past the guard). This does not reopen
--   the forgery this migration exists to close: the record UI
--   (`AssetDetailView.tsx`, PR-3 of this sequence) renders
--   `account_id`/`envelope_id` as DocuSign links ONLY when
--   `metadata.connector_source === 'docusign'` exactly, and `connector_source`
--   itself stays unconditionally guarded — so a forger who sets
--   `connector_source:'docusign'` to make any trust signal render also makes
--   `v_claims_docusign` true, which strips `connector_source` itself (no
--   signal renders at all) and strips/reverts `account_id`/`envelope_id`
--   right alongside it. A row that never claims DocuSign provenance never
--   triggers the guard on these two keys, so legitimate extracted values pass
--   through untouched.
--
--   The ONLY legitimate writers, confirmed this session by grepping every
--   `anchors` write site plus every literal occurrence of these 8 key names
--   as an object key across `src/` and `services/worker/src/` (excluding
--   generated `database.types.ts` and tests):
--     - `jobs/connector-artifact-drain.ts` (`connector_source`,
--       `connector_artifact_id` set directly on the `anchors` INSERT; also
--       carries `account_id`/`envelope_id` through from the connector_artifact
--       row's own metadata, itself written only by the paths below)
--     - `jobs/rule-action-dispatcher.ts` (`connector_source` set directly on
--       the `anchors` INSERT; deliberately persists `source_envelope_id` /
--       `account_id_sha256` instead of raw `envelope_id`/`account_id` for its
--       own declared-hash rules path — a different, already-hashed key pair,
--       untouched by this guard)
--     - `jobs/docusign-envelope-completed.ts` (`account_id`, `envelope_id`
--       into the `connector_artifact.metadata` staging row that
--       connector-artifact-drain.ts later carries into `anchors.metadata`)
--   All three import `db` from `services/worker/src/utils/db.ts`, which
--   authenticates with `config.supabaseServiceKey` — i.e. `service_role`.
--   `_signers`/`_docusign_env`/`_direction`/`_sending_account_id` have no
--   writer anywhere in the tree yet (PR-2/PR-4 of this sequence); guarding
--   them now is the "foundation for Finding 1" this ruling calls for. No
--   frontend call site (`SecureDocumentDialog.tsx`, `IssueCredentialForm.tsx`
--   — both direct `supabase.from('anchors').insert()` under the end user's own
--   session) sets `connector_source`, `connector_artifact_id`, `_signers`,
--   `_docusign_env`, `_direction`, or `_sending_account_id` as a product
--   feature — their metadata is built from AI-extracted/org-template field
--   keys, fraud-detection keys (`fraud_*`), and a small fixed app-key set,
--   none of which collide with those 6. There is no legitimate
--   non-service_role producer of those 6 to break. `account_id`/`envelope_id`
--   ARE plausible AI-extracted/org-template field names outside a DocuSign
--   context, which is exactly why they are guarded conditionally rather than
--   unconditionally, per CONDITIONAL GUARDING above.
--
-- STRIP/REVERT, NEVER RAISE — same asymmetry as 0384/0394: these keys live in
--   the free-form metadata blob whose writers' contract is "persist what is
--   understood, ignore the rest" (`bulk_create_anchors` copies the blob
--   wholesale, so a RAISE would surface as an opaque per-row `insert_failed`
--   and lose a whole CSV row over one ignorable key). Stripping keeps the
--   anchor and drops only the claim the server cannot stand behind.
--
-- WHY A SEPARATE FUNCTION + TRIGGER (not CREATE OR REPLACE of 0384's/0394's):
--   Same rationale as 0394's own header: extending either existing function
--   would put its unrelated key family's semantics at clobber risk from a
--   future editor of THIS file, and vice versa. A sibling trigger keeps each
--   guard's audit trail and rollback independent.
--
-- TRIGGER ORDER: BEFORE triggers fire in name order.
--   trg_prevent_metadata_edit
--     < trg_strip_unassertable_evidence_claims (0384)
--     < trg_strip_unattested_ce_provenance_keys (0394)
--     < trg_strip_unattested_docusign_metadata_keys (this file)
--   A post-SECURED metadata edit still hits the existing RAISE first, and
--   0384's/0394's strips run unchanged before this one — this file adds
--   coverage for a disjoint key set on INSERT and the PENDING window without
--   altering any existing error path or existing guard's behavior.
--
-- LOCKING: CREATE TRIGGER takes a brief ACCESS EXCLUSIVE lock on `anchors`
--   (catalog-only, no row scan and no rewrite of the table). `anchors` is a
--   CLAUDE.md §1.2 hot table, hence the bounded `SET LOCAL lock_timeout`
--   below (2026-08-11 P0 precedent, HANDOFF.md): if the lock cannot be
--   acquired within 5s the statement fails fast and can be retried, instead
--   of camping at the head of the FIFO lock queue and barrier-blocking
--   PostgREST schema-cache introspection for every later caller. No backfill:
--   existing rows are not audited or rewritten here — this changes ingest
--   only.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_strip_unattested_docusign_metadata_keys ON public.anchors;
--   DROP FUNCTION IF EXISTS public.enforce_docusign_metadata_key_authority();
--   NOTIFY pgrst, 'reload schema';
--   -- Reverting restores the pre-0423 behavior exactly: any authenticated
--   -- caller (direct PostgREST write, or bulk_create_anchors) can again set
--   -- or tamper with the DocuSign provenance key family in anchors.metadata.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.enforce_docusign_metadata_key_authority() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
DECLARE
  v_guarded constant text[] := ARRAY[
    'connector_source',
    'connector_artifact_id',
    'account_id',
    'envelope_id',
    '_signers',
    '_docusign_env',
    '_direction',
    '_sending_account_id'
  ]::text[];
  v_key text;
  v_meta jsonb;
  v_claims_docusign boolean;
BEGIN
  -- The worker connector pipeline (connector-artifact-drain.ts,
  -- rule-action-dispatcher.ts, docusign-envelope-completed.ts) is the only
  -- attesting writer, and it authenticates as service_role (§1.4). Everything
  -- below applies to browser/PostgREST callers and to SECURITY DEFINER RPCs
  -- (bulk_create_anchors) invoked under an end-user JWT.
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_meta := COALESCE(NEW.metadata, '{}'::jsonb);

  -- account_id/envelope_id are generic key names that also appear
  -- legitimately in NON-DocuSign metadata (AI-extracted document fields,
  -- org-template fields — see CONDITIONAL GUARDING in the file header). They
  -- are only forgeable as a DocuSign trust signal when the row also claims
  -- connector_source='docusign', so they are guarded ONLY in that context.
  -- Checked against both NEW (what the caller is trying to write) and OLD
  -- (what the row already is) so a caller cannot launder a real DocuSign
  -- row's account_id/envelope_id out from under the guard by simply omitting
  -- connector_source from their UPDATE payload.
  v_claims_docusign := (v_meta ? 'connector_source')
    OR (TG_OP = 'UPDATE' AND COALESCE(OLD.metadata ? 'connector_source', false));

  FOREACH v_key IN ARRAY v_guarded LOOP
    IF v_key IN ('account_id', 'envelope_id') AND NOT v_claims_docusign THEN
      CONTINUE;
    END IF;

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

ALTER FUNCTION public.enforce_docusign_metadata_key_authority() OWNER TO postgres;

-- SECURITY DEFINER hardening. On Supabase, ALTER DEFAULT PRIVILEGES grants anon
-- and authenticated EXECUTE *directly* at CREATE time, and `REVOKE ... FROM
-- PUBLIC` does not remove a direct role grant. This function RETURNS trigger, so
-- Postgres refuses a direct call and PostgREST never exposes it -- the ACL is not
-- reachable today. The revoke is still inline and adjacent to the definition
-- because CREATE OR REPLACE re-applies default privileges on every replay, so a
-- revoke living in a later migration would re-open on the next replay of this
-- file. No GRANT is paired with it: trigger invocation does not consult EXECUTE
-- on the trigger function (the privilege is checked at CREATE TRIGGER time, and
-- the owner retains it), so granting service_role here would be inert.
REVOKE ALL ON FUNCTION public.enforce_docusign_metadata_key_authority() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_docusign_metadata_key_authority() IS
  'DocuSign metadata key write authority (0423). Non-service_role callers may not introduce, change, or delete the service-stamped DocuSign provenance keys in anchors.metadata: connector_source, connector_artifact_id, _signers, _docusign_env, _direction, _sending_account_id are guarded unconditionally; account_id, envelope_id are guarded only when the row claims DocuSign provenance via connector_source, so the same generic names in non-DocuSign AI-extracted/org-template metadata pass through untouched. Guarded keys are stripped on INSERT, reverted to OLD on UPDATE, anchor still written. Closes the direct-PostgREST / bulk_create_anchors forgery of DocuSign trust links and signer rows (CTO Decision Record R1, security Finding 2).';

DROP TRIGGER IF EXISTS trg_strip_unattested_docusign_metadata_keys ON public.anchors;
CREATE TRIGGER trg_strip_unattested_docusign_metadata_keys
  BEFORE INSERT OR UPDATE OF metadata ON public.anchors
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_docusign_metadata_key_authority();

NOTIFY pgrst, 'reload schema';

COMMIT;
