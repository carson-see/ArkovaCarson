-- docusign-bilateral-evidence.sql
-- CTO Decision Record R9 (docusign-bilateral-2026-08) — SOC2 T3 soak evidence
-- queries for the DocuSign bilateral feature (PR #2472 metadata guard, #2474
-- outbound signer capture, #2476 inbound Recipient-Connect classification,
-- migration 0424 tenant-scoped nonce). Read-only. Run against the ISOLATED
-- staging rig the soak actually ran against (CLAUDE.md §1.11/§1.11A) — never
-- prod, never a shared rig mid-soak.
--
-- Run with:
--   psql "$DATABASE_URL" \
--     -v org_a_account_id='<org A DocuSign account_id>' \
--     -v org_b_account_id='<org B DocuSign account_id>' \
--     -f docusign-bilateral-evidence.sql
-- (those are ordinary shell quotes around the RAW value — psql's own
-- `:'var'` interpolation adds the SQL string-literal quoting itself; do not
-- double-quote the value). Defaults below are placeholders; either override
-- via -v or edit them directly before running.
--
-- SCHEMA NOTE: `connector_source` and `_direction`/`_signers`/etc. are NOT
-- real columns on `anchors` or `connector_artifact` — they are keys inside
-- the `metadata` jsonb column (see services/worker/src/api/v1/verify.ts
-- `resolveConnectorFetchSource`, which reads `metadata->>'connector_source'`,
-- not a column). `fingerprint_source` on `anchors` and every column on
-- `connector_artifact` used below (org_id, source, external_ref, metadata,
-- fingerprint_sha256) ARE real, typed columns (migrations 0343, 0376/0384).
-- `job_queue` has NO org_id column at all — org scoping there goes through
-- `payload->>'org_id'` (the docusign.envelope_completed job payload schema
-- requires `org_id`).
\set org_a_account_id 'CHANGE_ME_ORG_A_ACCOUNT_ID'
\set org_b_account_id 'CHANGE_ME_ORG_B_ACCOUNT_ID'
\set guard_probe_sentinel 'GUARD-PROBE-FORGED-ACCOUNT-DO-NOT-PERSIST'
\set docusign_job_type 'docusign.envelope_completed'

\echo '=== docusign-bilateral soak evidence ==='
\echo '--- org A account: ' :'org_a_account_id'
\echo '--- org B account: ' :'org_b_account_id'

-- ─────────────────────────────────────────────────────────────────────────
-- 1. OUTBOUND SIGNER CAPTURE (PR #2474, R6) — anchors carrying _signers
-- ─────────────────────────────────────────────────────────────────────────

\echo '--- [1a] count of DocuSign-sourced anchors carrying captured _signers ---'
SELECT count(*) AS anchors_with_signers
FROM public.anchors
WHERE metadata->>'connector_source' = 'docusign'
  AND metadata ? '_signers';

\echo '--- [1b] PII discipline: any captured signer entry with a name/email key (MUST be 0 rows) ---'
SELECT a.id AS anchor_id, a.public_id, elem AS offending_signer_entry
FROM public.anchors a,
     jsonb_array_elements(a.metadata->'_signers') AS elem
WHERE a.metadata->>'connector_source' = 'docusign'
  AND a.metadata ? '_signers'
  AND (elem ? 'name' OR elem ? 'email');

\echo '--- [1c] cap enforcement: any captured _signers array over 20 entries (MUST be 0 rows) ---'
SELECT a.id AS anchor_id, a.public_id, jsonb_array_length(a.metadata->'_signers') AS signer_count
FROM public.anchors a
WHERE a.metadata->>'connector_source' = 'docusign'
  AND a.metadata ? '_signers'
  AND jsonb_array_length(a.metadata->'_signers') > 20;

\echo '--- [1d] max-cardinality proof: at least one anchor materialized from a 100-document envelope carrying the full 20-signer cap ---'
SELECT a.id AS anchor_id, a.public_id, jsonb_array_length(a.metadata->'_signers') AS signer_count
FROM public.anchors a
WHERE a.metadata->>'connector_source' = 'docusign'
  AND a.metadata ? '_signers'
  AND jsonb_array_length(a.metadata->'_signers') = 20
ORDER BY a.created_at DESC
LIMIT 5;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. INBOUND CLASSIFICATION (PR #2476, R3/R4) — DECLARED_UNVERIFIED anchors
-- ─────────────────────────────────────────────────────────────────────────

\echo '--- [2a] count of inbound declared-hash anchors (fingerprint_source=issuer_record_attestation) ---'
SELECT count(*) AS inbound_declared_unverified_anchors
FROM public.anchors
WHERE fingerprint_source = 'issuer_record_attestation';

\echo '--- [2b] cross-check: matching count of _direction=inbound connector_artifact rows (should be >= 2a; drain may not have caught up) ---'
SELECT count(*) AS inbound_marked_connector_artifacts
FROM public.connector_artifact
WHERE source = 'docusign'
  AND metadata->>'_direction' = 'inbound';

\echo '--- [2c] every DECLARED_UNVERIFIED anchor must be connector_source=docusign (MUST equal 2a''s count) ---'
SELECT count(*) AS inbound_and_docusign_sourced
FROM public.anchors
WHERE fingerprint_source = 'issuer_record_attestation'
  AND metadata->>'connector_source' = 'docusign';

\echo '--- [2d] no_usable_declared_hash orphan-drops leave NO connector_artifact/anchor at all (informational — count of forged/legit inbound webhook attempts is only visible in worker logs, not this DB) ---'
\echo 'NOTE: the inbound_no_usable_hash family''s 200 ack is a pure no-write ack; there is nothing to query here by design. See the k6 run''s own check() results / response bodies for that family''s pass/fail signal.'

-- ─────────────────────────────────────────────────────────────────────────
-- 3. F1 PROVENANCE-CONFLICT DETECTION (security review of PR #2476)
-- ─────────────────────────────────────────────────────────────────────────

\echo '--- [3a] count of F1 provenance-conflict alerts (job_queue.last_error, sanitized text, no raw bytes per §1.6A) ---'
SELECT count(*) AS f1_provenance_conflict_alerts
FROM public.job_queue
WHERE type = :'docusign_job_type'
  AND last_error ILIKE '%docusign_connector_artifact_provenance_conflict%';

\echo '--- [3b] detail: which envelopes/orgs triggered it, for manual review ---'
SELECT id, payload->>'org_id' AS org_id, payload->>'envelope_id' AS envelope_id,
       status, attempts, last_error, updated_at
FROM public.job_queue
WHERE type = :'docusign_job_type'
  AND last_error ILIKE '%docusign_connector_artifact_provenance_conflict%'
ORDER BY updated_at DESC
LIMIT 50;

\echo '--- [3c] THE FORBIDDEN OUTCOME: an outbound job that reached status=completed for an envelope whose connector_artifact slot is owned by an INBOUND-marked row. Because 0343''s unique index (org_id, source, external_ref, ...) guarantees ON CONFLICT DO NOTHING lets exactly ONE writer win per envelope, "inbound owns the slot" + "the outbound job for that same envelope nonetheless reached completed" can ONLY mean the read-back-and-compare either did not run or passed a comparison it should have failed — i.e. a forged fingerprint was silently accepted as an outbound success. MUST be 0 rows. (external_ref, not a metadata key, is the join key -- it is the one column BOTH the inbound and outbound enqueue paths always populate with the DocuSign envelopeId.) ---'
SELECT jq.id AS job_id, jq.payload->>'envelope_id' AS envelope_id, ca.id AS connector_artifact_id, jq.status, jq.updated_at
FROM public.job_queue jq
JOIN public.connector_artifact ca
  ON ca.source = 'docusign'
 AND ca.external_ref = (jq.payload->>'envelope_id')
WHERE jq.type = :'docusign_job_type'
  AND jq.status = 'completed'
  AND ca.metadata->>'_direction' = 'inbound';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. GUARD-STRIP SUCCESS (PR #2472 metadata write-authority guard)
-- ─────────────────────────────────────────────────────────────────────────

\echo '--- [4a] the guard-probe sentinel must NEVER appear anywhere in anchors.metadata (MUST be 0 rows) ---'
SELECT id, public_id, org_id
FROM public.anchors
WHERE metadata->>'account_id' = :'guard_probe_sentinel'
   OR metadata::text LIKE '%' || :'guard_probe_sentinel' || '%';

\echo '--- [4b] same check against connector_artifact.metadata, in case a probe variant targets that table instead (MUST be 0 rows) ---'
SELECT id, org_id, external_ref
FROM public.connector_artifact
WHERE metadata::text LIKE '%' || :'guard_probe_sentinel' || '%';

\echo 'NOTE: [4a]/[4b] only catch a LEAK. The actual guard probe''s PASS/FAIL verdict (whether the forged UPDATE was rejected outright or silently stripped) comes from running docusign-guard-probe.js directly and reading its own report -- this SQL is the independent, whole-table confirmation that nothing it attempted ever actually landed, run any time after the probe (or the whole soak) completes.'

-- ─────────────────────────────────────────────────────────────────────────
-- 5. NONCE REPLAY REJECTION (migration 0424 tenant scope)
-- ─────────────────────────────────────────────────────────────────────────

\echo '--- [5a] DB-level integrity check: no duplicate nonce tuples exist (the UNIQUE constraint is what makes a replay a 200-duplicate instead of a second write) — MUST be 0 rows ---'
SELECT account_id, envelope_id, event_id, generated_at, count(*)
FROM public.docusign_webhook_nonces
GROUP BY account_id, envelope_id, event_id, generated_at
HAVING count(*) > 1;

\echo '--- [5b] tenant-scope column is actually populated for recent rows (proves migration 0424 is applied AND the code path supplies account_id on every write, not just some) ---'
SELECT count(*) FILTER (WHERE account_id IS NOT NULL) AS with_account_id,
       count(*) FILTER (WHERE account_id IS NULL) AS without_account_id_legacy_rows,
       count(*) AS total
FROM public.docusign_webhook_nonces
WHERE received_at > now() - interval '48 hours';

\echo 'NOTE: the AUTHORITATIVE replay-rejection count is the k6 run''s own summary — every "replay" and "replay_duplicate" family step is check()ed against its documented expectStatus (202 then 200); read that from the k6 JSON summary output, not this DB. [5a]/[5b] here are a DB-side integrity cross-check, not a substitute count.'

-- ─────────────────────────────────────────────────────────────────────────
-- 6. PER-ORG ISOLATION (both synthetic orgs, across the whole feature)
-- ─────────────────────────────────────────────────────────────────────────

\echo '--- [6a] connector_artifact rows: org_id vs metadata account_id must always agree with the ORG that account belongs to (MUST be 0 cross-attributed rows) ---'
SELECT id, org_id, metadata->>'account_id' AS metadata_account_id, source, external_ref
FROM public.connector_artifact
WHERE source = 'docusign'
  AND (
    (metadata->>'account_id' = :'org_a_account_id' AND org_id NOT IN (
      SELECT org_id FROM public.org_integrations WHERE account_id = :'org_a_account_id' AND provider = 'docusign' AND revoked_at IS NULL
      UNION
      SELECT org_id FROM public.member_integrations WHERE account_id = :'org_a_account_id' AND provider = 'docusign' AND revoked_at IS NULL
    ))
    OR
    (metadata->>'account_id' = :'org_b_account_id' AND org_id NOT IN (
      SELECT org_id FROM public.org_integrations WHERE account_id = :'org_b_account_id' AND provider = 'docusign' AND revoked_at IS NULL
      UNION
      SELECT org_id FROM public.member_integrations WHERE account_id = :'org_b_account_id' AND provider = 'docusign' AND revoked_at IS NULL
    ))
  );

\echo '--- [6b] job_queue: docusign.envelope_completed payload org_id/integration_id never crosses between the two synthetic orgs'' integrations (informational — lists distinct org_ids seen per account_id context; eyeball for exactly one org per account) ---'
SELECT ca.metadata->>'account_id' AS account_id, ca.org_id, count(*)
FROM public.connector_artifact ca
WHERE ca.source = 'docusign'
  AND ca.metadata->>'account_id' IN (:'org_a_account_id', :'org_b_account_id')
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '--- [6c] nonce rows: account_id never mixes with an envelope_id known to belong to the OTHER org''s connector_artifact rows (MUST be 0 rows) ---'
SELECT n.account_id, n.envelope_id, n.event_id
FROM public.docusign_webhook_nonces n
JOIN public.connector_artifact ca ON ca.external_ref = n.envelope_id AND ca.source = 'docusign'
WHERE n.account_id IS NOT NULL
  AND n.account_id <> (ca.metadata->>'account_id');

-- ─────────────────────────────────────────────────────────────────────────
-- 7. WORKER-UPTIME CONTINUITY (proxy only — see NOTE)
-- ─────────────────────────────────────────────────────────────────────────

\echo '--- [7] hourly count of processed docusign.envelope_completed jobs across the soak window — eyeball for a zero-count gap (a proxy signal only) ---'
SELECT date_trunc('hour', updated_at) AS hour_bucket, status, count(*)
FROM public.job_queue
WHERE type = :'docusign_job_type'
  AND updated_at > now() - interval '48 hours'
GROUP BY 1, 2
ORDER BY 1, 2;

\echo 'NOTE (per memory/feedback_soak_clock_is_worker_uptime.md): this table is a PROXY, not the authoritative uptime signal -- a gap here could mean the worker restarted, OR just that k6 wasn''t sending bilateral traffic that hour, OR that the ENABLE_DOCUSIGN_INBOUND flag was off so inbound families produced no durable job/write at all. The authoritative soak-continuity signal is Cloud Run REVISION UPTIME (`gcloud run services describe <service> --format=...` / the deploy log), not this query. Cite that, not this, as the uptime claim.'

\echo '=== end docusign-bilateral soak evidence ==='
