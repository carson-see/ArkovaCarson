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
-- Expected outcomes are asserted by services/worker/scripts/pr2461-pii-redaction-driver.ts:
--   * pii    -> 404 (gate fails closed) OR 200 with the address absent. Never a
--               200 carrying the address.
--   * redos  -> bounded latency. The dotted run is the shape that defeats the
--               old pattern's leading `\b`.
--   * longlp -> the >64-octet local-part the OLD pattern silently failed to
--               detect. Fail-closed 404 here is the fix working.

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
  'PR2461 fixture — planted address in free text; gate must scrub or fail closed.',
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
  'PR2461 fixture — adversarial dotted run; latency probe for the quadratic pattern.',
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
  'PR2461 fixture — >64-octet local part the OLD pattern failed to detect.',
  jsonb_build_object(
    '_fixture', true, '_synthetic', true, '_pr', 2461,
    'notes', 'reach ' || repeat('x', 80) || '@mail.example.com today'
  ),
  true, NOW()
)
ON CONFLICT (id) DO UPDATE
SET metadata    = EXCLUDED.metadata,
    description = EXCLUDED.description,
    status      = EXCLUDED.status,
    legal_hold  = true,
    updated_at  = NOW();

COMMIT;
