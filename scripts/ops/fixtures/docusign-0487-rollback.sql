\set ON_ERROR_STOP on
-- AR20-93: synthetic, isolated PostgreSQL contract for migration 0487 rollback.
-- This fixture is never run against a Supabase project or shared database.
CREATE TABLE public.connector_artifact (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('google_drive', 'docusign', 'microsoft_365', 'manual_upload', 'batch_upload')),
  external_ref text NOT NULL,
  external_revision text,
  fingerprint_sha256 text NOT NULL CHECK (fingerprint_sha256 ~ '^[a-f0-9]{64}$')
);

-- Exact dedupe index from migration 0343; the runner compares this text with
-- the source migration before it starts PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_artifact_dedupe
  ON public.connector_artifact (org_id, source, external_ref, COALESCE(external_revision, ''));

INSERT INTO public.connector_artifact
  (id, org_id, source, external_ref, external_revision, fingerprint_sha256)
VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000001',
   'docusign', 'synthetic-envelope', NULL, repeat('a', 64));

-- The snapshot exists BEFORE 0487 changes the pre-existing row.
CREATE TEMP TABLE pre_0487_row_ids (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  external_ref text NOT NULL,
  fingerprint_sha256 text NOT NULL
);
INSERT INTO pre_0487_row_ids
SELECT id, org_id, external_ref, fingerprint_sha256 FROM public.connector_artifact
WHERE source = 'docusign' AND external_revision IS NULL;

DO $$
BEGIN
  IF (SELECT count(*) FROM pre_0487_row_ids) <> 1 THEN
    RAISE EXCEPTION 'pre-0487 cohort snapshot missing or ambiguous';
  END IF;
END $$;

-- Exact forward backfill from migration 0487.
UPDATE public.connector_artifact
SET external_revision = fingerprint_sha256
WHERE source = 'docusign' AND external_revision IS NULL;

-- Two new versions of the same envelope, as current producers write them.
INSERT INTO public.connector_artifact
  (id, org_id, source, external_ref, external_revision, fingerprint_sha256)
VALUES
  ('aaaaaaaa-0000-4000-8000-000000000002',
   'bbbbbbbb-0000-4000-8000-000000000001',
   'docusign', 'synthetic-envelope', repeat('b', 64), repeat('b', 64)),
  ('aaaaaaaa-0000-4000-8000-000000000003',
   'bbbbbbbb-0000-4000-8000-000000000001',
   'docusign', 'synthetic-envelope', repeat('c', 64), repeat('c', 64));

-- The header's predicate selects all three rows, not just the snapshot.
DO $$
DECLARE selected_count integer;
BEGIN
  SELECT count(*) INTO selected_count
  FROM public.connector_artifact
  WHERE source = 'docusign' AND external_revision = fingerprint_sha256;
  IF selected_count <> 3 THEN
    RAISE EXCEPTION 'unsafe predicate selected %, expected 3', selected_count;
  END IF;
  BEGIN
    UPDATE public.connector_artifact
    SET external_revision = NULL
    WHERE source = 'docusign'
      AND external_revision = fingerprint_sha256;
    RAISE EXCEPTION 'blanket rollback unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    -- The exact 0343 expression index rejects the collapsed envelope key.
    NULL;
  END;
  IF (SELECT count(*) FROM public.connector_artifact WHERE external_revision IS NULL) <> 0 THEN
    RAISE EXCEPTION 'blanket failure was not atomic';
  END IF;
END $$;

-- The same guards are invoked by the positive transaction and negative
-- snapshot cases below; a fake that merely mirrors the predicate is weaker.
CREATE FUNCTION pg_temp.assert_snapshot(expected_count integer, expected_null_revision boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM pre_0487_row_ids) <> expected_count
     OR expected_count = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P9301', MESSAGE = 'missing or wrong-count snapshot';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pre_0487_row_ids
    GROUP BY org_id, external_ref HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P9303', MESSAGE = 'two cohort rows for one envelope';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pre_0487_row_ids snapshot
    LEFT JOIN public.connector_artifact current ON current.id = snapshot.id
    WHERE current.id IS NULL
       OR current.org_id <> snapshot.org_id
       OR current.source <> 'docusign'
       OR current.external_ref <> snapshot.external_ref
       OR current.fingerprint_sha256 <> snapshot.fingerprint_sha256
       OR (expected_null_revision AND current.external_revision IS NOT NULL)
       OR (NOT expected_null_revision
           AND current.external_revision IS DISTINCT FROM current.fingerprint_sha256)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P9302', MESSAGE = 'snapshot identity differs from current row';
  END IF;
END $$;

CREATE FUNCTION pg_temp.assert_no_null_collision()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.connector_artifact selected
    JOIN pre_0487_row_ids cohort ON cohort.id = selected.id
    JOIN public.connector_artifact other
      ON other.id <> selected.id
     AND other.org_id = selected.org_id
     AND other.source = selected.source
     AND other.external_ref = selected.external_ref
     AND COALESCE(other.external_revision, '') = ''
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P9304', MESSAGE = 'NULL-revision collision';
  END IF;
END $$;

CREATE FUNCTION pg_temp.assert_no_reapply_collision()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.connector_artifact selected
    JOIN pre_0487_row_ids cohort ON cohort.id = selected.id
    JOIN public.connector_artifact other
      ON other.id <> selected.id
     AND other.org_id = selected.org_id
     AND other.source = selected.source
     AND other.external_ref = selected.external_ref
     AND COALESCE(other.external_revision, '') = selected.fingerprint_sha256
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P9305', MESSAGE = 'target fingerprint revision collision';
  END IF;
END $$;

DO $$
BEGIN
  UPDATE pre_0487_row_ids SET fingerprint_sha256 = repeat('f', 64)
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
  BEGIN
    PERFORM pg_temp.assert_snapshot(1);
    RAISE EXCEPTION 'wrong-identity snapshot unexpectedly passed';
  EXCEPTION WHEN SQLSTATE 'P9302' THEN NULL;
  END;
  UPDATE pre_0487_row_ids SET fingerprint_sha256 = repeat('a', 64)
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';

  INSERT INTO pre_0487_row_ids
  SELECT id, org_id, external_ref, fingerprint_sha256
  FROM public.connector_artifact
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  BEGIN
    PERFORM pg_temp.assert_snapshot(2);
    RAISE EXCEPTION 'same-envelope cohort unexpectedly passed';
  EXCEPTION WHEN SQLSTATE 'P9303' THEN NULL;
  END;
  DELETE FROM pre_0487_row_ids
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
END $$;

-- Rehearse the documented bounded transaction, not an autocommit UPDATE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.connector_artifact IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE reversed_count integer;
BEGIN
  PERFORM pg_temp.assert_snapshot(1);
  PERFORM pg_temp.assert_no_null_collision();
  UPDATE public.connector_artifact selected
  SET external_revision = NULL
  FROM pre_0487_row_ids cohort
  WHERE selected.id = cohort.id
    AND selected.source = 'docusign'
    AND selected.external_revision = selected.fingerprint_sha256;
  GET DIAGNOSTICS reversed_count = ROW_COUNT;
  IF reversed_count <> 1 THEN
    RAISE EXCEPTION 'scoped reversal count %, expected 1', reversed_count;
  END IF;
  IF (SELECT count(*) FROM public.connector_artifact
      WHERE id IN ('aaaaaaaa-0000-4000-8000-000000000002',
                   'aaaaaaaa-0000-4000-8000-000000000003')
        AND external_revision = fingerprint_sha256) <> 2 THEN
    RAISE EXCEPTION 'post-cutover version key changed';
  END IF;
END $$;
COMMIT;

-- A later row can claim the old fingerprint key while the captured row is
-- NULL. Reapply must stop at preflight instead of discovering this by write.
INSERT INTO public.connector_artifact
  (id, org_id, source, external_ref, external_revision, fingerprint_sha256)
VALUES
  ('aaaaaaaa-0000-4000-8000-000000000005',
   'bbbbbbbb-0000-4000-8000-000000000001',
   'docusign', 'synthetic-envelope', repeat('a', 64), repeat('e', 64));
DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.assert_no_reapply_collision();
    RAISE EXCEPTION 'reapply collision preflight unexpectedly passed';
  EXCEPTION WHEN SQLSTATE 'P9305' THEN NULL;
  END;
END $$;
DELETE FROM public.connector_artifact
WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005';

-- Reapply only the captured row, keeping post-cutover rows unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.connector_artifact IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE reapplied_count integer;
BEGIN
  PERFORM pg_temp.assert_snapshot(1, true);
  PERFORM pg_temp.assert_no_reapply_collision();
  UPDATE public.connector_artifact selected
  SET external_revision = selected.fingerprint_sha256
  FROM pre_0487_row_ids cohort
  WHERE selected.id = cohort.id
    AND selected.source = 'docusign'
    AND selected.external_revision IS NULL;
  GET DIAGNOSTICS reapplied_count = ROW_COUNT;
  IF reapplied_count <> 1 THEN
    RAISE EXCEPTION 'reapply count %, expected 1', reapplied_count;
  END IF;
  IF (SELECT count(*) FROM public.connector_artifact
      WHERE external_revision = fingerprint_sha256) <> 3 THEN
    RAISE EXCEPTION 'reapply did not restore all three version keys';
  END IF;
END $$;
COMMIT;

-- Missing snapshot exercises the SAME guard used by the real transaction.
DO $$
BEGIN
  DELETE FROM pre_0487_row_ids
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
  BEGIN
    PERFORM pg_temp.assert_snapshot(1);
    RAISE EXCEPTION 'missing-snapshot guard did not stop';
  EXCEPTION WHEN SQLSTATE 'P9301' THEN NULL;
  END;
  INSERT INTO pre_0487_row_ids
  SELECT id, org_id, external_ref, fingerprint_sha256
  FROM public.connector_artifact
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
END $$;

-- A mixed old worker can add a NULL-revision row after 0487. The preflight
-- must stop before reversal; the unique index would also reject an update.
INSERT INTO public.connector_artifact
  (id, org_id, source, external_ref, external_revision, fingerprint_sha256)
VALUES
  ('aaaaaaaa-0000-4000-8000-000000000004',
   'bbbbbbbb-0000-4000-8000-000000000001',
   'docusign', 'synthetic-envelope', NULL, repeat('d', 64));

DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.assert_no_null_collision();
    RAISE EXCEPTION 'mixed-writer collision preflight unexpectedly passed';
  EXCEPTION WHEN SQLSTATE 'P9304' THEN NULL;
  END;
  BEGIN
    UPDATE public.connector_artifact selected
    SET external_revision = NULL
    FROM pre_0487_row_ids cohort
    WHERE selected.id = cohort.id;
    RAISE EXCEPTION 'collision update unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  IF (SELECT external_revision FROM public.connector_artifact
      WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001') <> repeat('a', 64) THEN
    RAISE EXCEPTION 'collision failure changed captured row';
  END IF;
END $$;

SELECT 'AR20_93_PASS:blanket_3_conflict:scoped_1:post_2:reapply_1:missing_snapshot_stop:collision_stop:reapply_collision_stop';
