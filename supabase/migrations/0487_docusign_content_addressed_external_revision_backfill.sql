-- 0487_docusign_content_addressed_external_revision_backfill.sql
-- fix/docusign-content-addressed-revision (PR #TBD) — backfill
--   `connector_artifact.external_revision` for existing `source='docusign'`
--   rows, paired with the code fix landing in the same PR that makes both
--   DocuSign enqueue call sites (`services/worker/src/jobs/
--   docusign-envelope-completed.ts` and `services/worker/src/api/v1/webhooks/
--   docusign.ts`) write `external_revision = fingerprint_sha256` going forward
--   instead of `null`.
--
-- WHY
-- ---
-- `connector_artifact`'s dedupe/idempotency key (mig 0343) is
--   (org_id, source, external_ref, COALESCE(external_revision, '')).
-- In prod this is populated on 8/8 `google_drive` rows and 0/27 `docusign`
-- rows — every DocuSign artifact enqueue passed `p_external_revision: null`,
-- degenerating the key from per-VERSION to per-ENVELOPE for the entire
-- source. DocuSign Connect's envelope-completed payload
-- (`DocusignEnvelopeCompleted`, integrations/connectors/schemas.ts) carries no
-- native revision token — no `documentIdGuid`, `statusChangedDateTime`,
-- `completedDateTime`, `sentDateTime`, or ETag — and DocuSign has no revision
-- concept for a completed envelope: an amendment is a new envelope, not a new
-- version of the same one. `fingerprint_sha256` is therefore the only
-- per-version identity this vendor gives us, mirroring the precedent already
-- in this codebase for a source with no native revision (Drive's synthetic
-- `mtime:<time>` / `evt:<time>:<fileId>` tokens via `DRIVE_REVISION_KINDS`,
-- `services/worker/src/jobs/drive-artifact-producer.ts`).
--
-- THE BACKFILL IS MANDATORY, NOT OPTIONAL. Once the code change ships,
-- a genuine post-fix event for one of the 27 pre-existing envelopes would
-- compute dedupe key (org, docusign, envelopeId, <fingerprint>), which does
-- NOT match the existing row's key (org, docusign, envelopeId, '') — because
-- COALESCE(NULL, '') = ''. Without this backfill, that mismatch produces a
-- SPURIOUS duplicate connector_artifact row for an envelope that should have
-- deduped against its own pre-existing row.
--
-- SAFETY. `fingerprint_sha256` is NOT NULL on every existing row (table
-- definition, mig 0343) with a CHECK requiring 64 lowercase-hex characters
-- (`connector_artifact_fingerprint_format_check`) — copying it into
-- `external_revision` invents nothing and cannot fail that same CHECK
-- (`external_revision`, per mig 0343, is unconstrained text; a valid
-- `fingerprint_sha256` value is trivially valid `external_revision` text).
-- The unique index cannot be violated by this backfill: before it runs, every
-- `docusign` row already has `external_revision IS NULL`, so the index
-- already enforces AT MOST ONE row per (org_id, source, external_ref)
-- pre-migration; this statement changes only the 4th key component's value
-- for existing rows and touches neither `org_id` nor `external_ref`, so the
-- distinctness of (org_id, source, external_ref) across rows is preserved
-- and the new (org_id, source, external_ref, fingerprint_sha256) tuples
-- remain pairwise distinct for exactly the same reason.
-- Idempotent: the `WHERE external_revision IS NULL` predicate means a second
-- run corrects zero rows.
-- Scope: `source = 'docusign'` only. `google_drive` (already populated) and
-- any future source are untouched.
--
-- ROLLBACK:
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   UPDATE public.connector_artifact
--   SET external_revision = NULL
--   WHERE source = 'docusign'
--     AND external_revision = fingerprint_sha256;
--   COMMIT;
--   (Restores the exact pre-migration NULL state. Safe to re-run: a row
--   already NULL, or one whose external_revision no longer equals its own
--   fingerprint_sha256 — e.g. F1-heal superseded it after this migration ran
--   — is left untouched by the `AND external_revision = fingerprint_sha256`
--   guard, so a rollback only reverts rows this migration itself set.)
--
-- Tier: T3 (touches supabase/migrations/ + the connector-artifact dedupe key
--   used by anchor materialization). No schema change: no
--   `database.types.ts` delta and no `NOTIFY pgrst, 'reload schema'` — this
--   is data only.
-- NOT APPLIED anywhere (no rig, no staging, no prod). Ordering per CLAUDE.md
--   §0 rule 10 / `.claude/hooks/check-prod-migration-apply.sh`: this file's
--   `0487` prefix must land on `origin/main` (or be listed in
--   `scripts/ci/snapshots/ledger-numeric-exemptions.json`) before any
--   `apply_migration` against a prod-linked ref is permitted.

BEGIN;

-- `connector_artifact` is not one of the three CLAUDE.md §1.2 HOT_TABLES
-- (organizations/anchors/profiles), but this statement still WRITES to it, so
-- bound the lock wait rather than queuing unbounded behind a long reader.
-- Wrapped in BEGIN/COMMIT because a bare `SET LOCAL` outside a transaction is
-- discarded by `db push` (25P01).
SET LOCAL lock_timeout = '5s';

UPDATE public.connector_artifact
SET external_revision = fingerprint_sha256
WHERE source = 'docusign'
  AND external_revision IS NULL;

-- Post-condition: every docusign row must come out of this migration with a
-- non-null external_revision. Fail loudly rather than report a hollow
-- success if some row was somehow excluded above.
DO $$
DECLARE
  v_remaining bigint;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM public.connector_artifact
  WHERE source = 'docusign'
    AND external_revision IS NULL;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'docusign external_revision backfill incomplete: % row(s) still NULL',
      v_remaining;
  END IF;
END
$$;

COMMIT;
