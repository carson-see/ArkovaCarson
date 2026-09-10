-- scripts/staging/seed-pr2461-pii-fixture.sql
--
-- Supplementary soak fixture for PR #2461 (server-side EMAIL_PATTERN fix).
--
-- §1.11A DATA-ONLY and idempotent: inserts three synthetic anchors and writes
-- NOTHING to supabase_migrations, runs no migration repair, and re-runs cleanly
-- via ON CONFLICT. Run AFTER scripts/staging/seed-baseline-fixture.sql, whose
-- org/user rows these reference and whose switchboard_flags row is what keeps
-- /api/v1 from being dark.
--
-- WHY THESE THREE ROWS: the CTDL projection is the only public route that
-- reaches containsHighConfidencePii, and it only reaches it for a credential
-- type that actually publishes free text. CLE is deliberately EXCLUDED from
-- EDUCATION_CREDENTIAL_TYPES (see services/worker/src/ctdl/agents.md), so its
-- descriptive title IS published and the PII gate genuinely runs. An academic
-- type would suppress the free text structurally and the gate would never fire,
-- making the soak look green while testing nothing.
--
-- SIZE NOTE, and it is a finding rather than a detail: `anchors_description_max_length`
-- caps description at 500 characters, so the CTDL projection's free-text surface
-- is DB-bounded far below MAX_SCAN_CHARS (4000). The adversarial dotted run here
-- is therefore ~490 chars, and the quadratic pattern costs well under a
-- millisecond on it. The CTDL route is NOT where the latency exposure lived; the
-- uncapped `Jsonish` path into the CPE/CLE extraction prompts is. What this
-- fixture proves on the CTDL route is DETECTION CORRECTNESS (see LONGLP below),
-- not throughput.
--
-- THE PAYLOADS LIVE IN `description`, NOT `metadata`. Verified against the live
-- rig on 2026-08-29: the CTDL body carries ceterms:name and ceterms:description
-- but does NOT project metadata.notes, so a payload parked in metadata never
-- reaches containsHighConfidencePii and the soak is HOLLOW while looking green.
--
-- Expected outcomes are asserted by services/worker/scripts/pr2461-pii-redaction-driver.ts:
--   * pii    -> 404 (gate fails closed) OR 200 with the address absent. Never a
--               200 carrying the address.
--   * redos  -> bounded latency. The dotted run is the shape that defeats the
--               old pattern's leading `\b`.
--   * longlp -> a >64-octet local part. NOTE: this is a NO-REGRESSION check,
--               not a discriminator. The OLD pattern was unbounded and detects
--               it fine (verified on the rig by serving both images against
--               these rows: PRE-FIX and POST-FIX both suppress it). The >64
--               MISS belongs to the naive `keep \b + bound` port. What this row
--               buys is that a future naive re-port turns the soak red.
--   * extract -> the anchor the queued extraction jobs target. This is where the
--               REAL discriminator lives: job `evidence` is uncapped jsonb, so a
--               40k dotted run costs ~3.2 s per job pre-fix and ~0.02 ms after.

BEGIN;

-- Transaction-local service_role claim so protect_anchor_status_transition()
-- takes its fast path; without it the SECURED write is rejected. Local to this
-- transaction only, exactly as the baseline fixture does it.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

INSERT INTO public.anchors (
  id, user_id, org_id, public_id, filename, fingerprint, status, credential_type,
  chain_tx_id, file_size, file_mime, description, metadata, legal_hold, created_at
) VALUES
(
  '5eed2461-0000-4000-8000-000000000001',
  '5eed0000-0000-4000-8000-0000000000a1',
  '5eed0000-0000-4000-8000-0000000000b1',
  'ARK-SOAK-2461-PII',
  'seed-pr2461-pii.pdf',
  md5('arkova-pr2461-pii-hi') || md5('arkova-pr2461-pii-lo'),
  'SECURED', 'CLE',
  md5('arkova-pr2461-pii-txid-hi') || md5('arkova-pr2461-pii-txid-lo'),
  4096, 'application/pdf',
  'PR2461 fixture. Course contact jane.doe@example.com for ethics credit questions.',
  jsonb_build_object(
    '_fixture', true, '_synthetic', true, '_pr', 2461,
    'notes', 'course contact jane.doe@example.com for ethics credit questions'
  ),
  true, NOW()
),
(
  '5eed2461-0000-4000-8000-000000000002',
  '5eed0000-0000-4000-8000-0000000000a1',
  '5eed0000-0000-4000-8000-0000000000b1',
  'ARK-SOAK-2461-REDOS',
  'seed-pr2461-redos.pdf',
  md5('arkova-pr2461-redos-hi') || md5('arkova-pr2461-redos-lo'),
  'SECURED', 'CLE',
  md5('arkova-pr2461-redos-txid-hi') || md5('arkova-pr2461-redos-txid-lo'),
  4096, 'application/pdf',
  'PR2461 fixture adversarial dotted run ' || repeat('a.', 229) || '!',
  jsonb_build_object(
    '_fixture', true, '_synthetic', true, '_pr', 2461,
    -- 3,998 chars of 'a.' sits just inside MAX_SCAN_CHARS (4000), so the whole
    -- run reaches the detector rather than being truncated before it.
    'notes', repeat('a.', 1999) || '!'
  ),
  true, NOW()
),
(
  '5eed2461-0000-4000-8000-000000000003',
  '5eed0000-0000-4000-8000-0000000000a1',
  '5eed0000-0000-4000-8000-0000000000b1',
  'ARK-SOAK-2461-LONGLP',
  'seed-pr2461-longlp.pdf',
  md5('arkova-pr2461-longlp-hi') || md5('arkova-pr2461-longlp-lo'),
  'SECURED', 'CLE',
  md5('arkova-pr2461-longlp-txid-hi') || md5('arkova-pr2461-longlp-txid-lo'),
  4096, 'application/pdf',
  'PR2461 fixture reach ' || repeat('x', 80) || '@mail.example.com today',
  jsonb_build_object(
    '_fixture', true, '_synthetic', true, '_pr', 2461,
    'notes', 'reach ' || repeat('x', 80) || '@mail.example.com today'
  ),
  true, NOW()
),
(
  '5eed2461-0000-4000-8000-000000000004',
  '5eed0000-0000-4000-8000-0000000000a1',
  '5eed0000-0000-4000-8000-0000000000b1',
  'ARK-SOAK-2461-EXTRACT',
  'seed-pr2461-extract.pdf',
  md5('arkova-pr2461-extract-hi') || md5('arkova-pr2461-extract-lo'),
  'SECURED', 'CLE',
  md5('arkova-pr2461-extract-txid-hi') || md5('arkova-pr2461-extract-txid-lo'),
  4096, 'application/pdf',
  'PR2461 fixture — target anchor for queued CPE/CLE extraction jobs.',
  jsonb_build_object('_fixture', true, '_synthetic', true, '_pr', 2461),
  true, NOW()
)
ON CONFLICT (id) DO UPDATE
SET metadata     = EXCLUDED.metadata,
    description  = EXCLUDED.description,
    status       = EXCLUDED.status,
    legal_hold   = true,
    -- MUST be reset: processProfessionalEducationExtractionJob returns early on
    -- `alreadyExtracted` without ever calling stripProfessionalEducationPii, so
    -- a populated cle_metadata turns every later cycle into a silent no-op.
    cle_metadata = NULL,
    updated_at   = NOW();

COMMIT;
