-- PR #2499 fixture — the DISCRIMINATOR for "declared hash" vs "measured at fetch time".
--
-- The whole point of this PR is that a connector-SOURCED anchor is not
-- automatically a connector-FETCHED one. So the fixture is a controlled pair:
-- both rows carry metadata.connector_source='docusign'; ONLY the control row
-- carries connector_artifact_id, which is the proof that a server-side fetch
-- actually happened (connector-artifact-drain is its only writer).
--
--   ARK-P2499-DECLARED : connector_source, NO connector_artifact_id
--       -> fingerprint_rederivability MUST BE ABSENT (the fix)
--       -> on unfixed code it is present as "fetch_time_snapshot" + a
--          "Measured: ... Arkova computed its fingerprint" note  <-- the failure
--   ARK-P2499-MEASURED : connector_source AND connector_artifact_id
--       -> fingerprint_rederivability MUST STILL BE PRESENT (over-suppression
--          would be its own regression, so this row is the POSITIVE CONTROL)
--
-- Data-only insert. Touches no migration ledger row (CLAUDE.md §1.11A).
\set ON_ERROR_STOP on
BEGIN;

WITH org AS (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
INSERT INTO anchors (org_id, public_id, fingerprint, status, metadata, created_at)
SELECT org.id,
       'ARK-P2499-DECLARED',
       repeat('a', 64),
       'SECURED',
       jsonb_build_object(
         'connector_source', 'docusign',
         'external_file_id', 'p2499-declared-file'
       ),
       now()
FROM org
ON CONFLICT (public_id) DO UPDATE
  SET metadata = EXCLUDED.metadata, status = EXCLUDED.status;

WITH org AS (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
INSERT INTO anchors (org_id, public_id, fingerprint, status, metadata, created_at)
SELECT org.id,
       'ARK-P2499-MEASURED',
       repeat('b', 64),
       'SECURED',
       jsonb_build_object(
         'connector_source', 'docusign',
         'external_file_id', 'p2499-measured-file',
         'connector_artifact_id', 'p2499-artifact-0001'
       ),
       now()
FROM org
ON CONFLICT (public_id) DO UPDATE
  SET metadata = EXCLUDED.metadata, status = EXCLUDED.status;

COMMIT;

-- Read back so the seeding step is itself evidence, not an assumption.
SELECT public_id,
       metadata->>'connector_source'      AS connector_source,
       metadata->>'connector_artifact_id' AS connector_artifact_id,
       fingerprint_source
FROM anchors
WHERE public_id IN ('ARK-P2499-DECLARED','ARK-P2499-MEASURED')
ORDER BY public_id;
