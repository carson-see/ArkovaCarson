-- scripts/staging/seed-rc-batch-0902-fixture.sql
--
-- rc/soak-batch-2026-09-02 (batched T2) soak fixture for ISOLATED rigs.
--
-- SEPARATE FILE ON PURPOSE. `seed-baseline-fixture.sql` is the SHARED
-- provisioning baseline every rig runs, and it OWNS the ENABLE_VERIFICATION_API
-- switchboard row. This file is additive, RC-owned, and runs AFTER the baseline.
-- Do not fold it into the baseline.
--
-- WHAT THE RC CHANGED, AND THEREFORE WHAT THIS FIXTURE HAS TO MAKE OBSERVABLE
-- --------------------------------------------------------------------------
--   #2527  GET /api/v1/verify/:publicId/proof gained `verdict` (valid | invalid |
--          unverifiable) + `verdict_note` next to the unchanged boolean
--          `verified`. At the RC head the mapping is:
--            - cryptographic recompute FAILED                      -> invalid
--            - recompute passed AND the CVE-2012-2459 guard was
--              actually EXERCISED (merkle_index present, leaf_count
--              >= 1, AND branch length == depth(leaf_count))         -> valid
--            - anything else (no merkle_index; empty branch under a
--              multi-leaf claim; branch longer than the tree)        -> unverifiable
--          A rig database has no rows in ANY of those states unless something
--          puts them there. This file seeds one cohort per state.
--   #2525  GET /api/v1/verify/attestation/:id is PARKED at the router: every
--          well-formed id answers one fixed 404, below the rate limiters and
--          above usageTracking. A park over an EMPTY table proves nothing about
--          disclosure. `legally_binding_attestations` is empty in every
--          environment (0 rows in prod, verified 2026-08-31 per
--          middleware/parkedAttestationVerify.ts), so this file populates it
--          across ALL FIVE statuses with natural-person subject names and
--          notary commission details. The driver then proves none of it leaves
--          the park.
--   #2526  detect-reorgs manifest entry: no fixture needed (POST
--          /jobs/detect-reorgs runs against whatever SECURED rows exist; the
--          fixture's rows are legal_hold=true and far below the reorg-check
--          depth, so the job cannot touch them).
--   #2528  frontend only — covered by e2e/rc-batch-0902-frontend-evidence.spec.ts,
--          not by this fixture.
--
-- TWO ORGS, ON PURPOSE
-- --------------------
-- Org A (VERIFIED, `notarized`-type attestations) and org B (UNVERIFIED,
-- `witnessed`-type attestations) each own anchors and attestations, so the
-- driver's per-org attribution check has two sides: A's public ids must answer
-- with A's fingerprints and A's org name, never B's, and vice versa.
--
-- THE PROOF COHORTS (11 anchors, all SECURED, all on real mainnet receipts)
-- -------------------------------------------------------------------------
--   a-valid        2 rows  one 2-leaf batch, correct siblings, merkle_index 0/1,
--                          complete bitcoin-tree columns            -> valid
--   a-invalid      2 rows  same 2-leaf shape, TRUE root, but each row's stored
--                          sibling is deliberately WRONG              -> invalid
--   a-legacy       2 rows  correct 2-leaf branches, merkle_index NULL
--                          (the pre-PROOF-02 back-catalogue shape)   -> unverifiable
--   a-uninspected  2 rows  merkle_index 0/1 in a 2-row batch, but proof_path=[]
--                          and merkle_root = own fingerprint: the recompute
--                          passes trivially while the guard inspects nothing.
--                          The PREVIOUS RC head (557e485a) answered `valid`;
--                          the current head must answer `unverifiable`
--                                                                    -> unverifiable
--   a-overlong     1 row   single-row batch (leaf_count 1) carrying a ONE-sibling
--                          branch whose root is sha256d(leaf||sibling): passes
--                          the recompute, but the branch is longer than the
--                          tree is deep. Previous RC head: `valid`
--                                                                    -> unverifiable
--   b-valid        2 rows  org B's counterpart to a-valid            -> valid
--
-- The a-valid / b-valid / a-uninspected / a-overlong rows carry a COMPLETE
-- bitcoin-tree half (real 80-byte block header, real block hash, canonical
-- "ARKV"||root OP_RETURN payload), so `/proof` publishes a non-null
-- `proof_bundle` for them. a-legacy has no merkle_index and a-invalid fails the
-- recompute, so those bundles are null by the endpoint's own rules.
--
-- REAL MAINNET TRANSACTIONS AND HEADERS — AND WHERE THEY CAME FROM
-- ----------------------------------------------------------------
-- The six txids are REAL Arkova mainnet anchoring transactions, reused from
-- scripts/staging/seed-proof-txinclusion-fixture.sql (branch
-- soak/proof-txincl-driver, which read them SELECT-only from prod
-- vzwyaatejekddvltxyye on 2026-09-02). Each was re-confirmed on 2026-09-02
-- against the public chain (mempool.space /api/tx/<txid>/status), and the two
-- block headers were fetched from mempool.space /api/block/<hash>/header and
-- cross-checked against blockstream.info:
--
--   Block A  000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045
--            height 960657, time 1785637848, five of the six txids
--   Block B  00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2
--            height 962144, time 1786538405, the b-valid txid
--
-- NOTE ON HEIGHTS: the #2524 fixture records these blocks at 960655 / 962141
-- (copied from prod anchor_proofs.block_height). Both public explorers put the
-- hashes at 960657 / 962144, and the post-condition block below proves the
-- embedded headers hash to exactly these block hashes. This file uses the
-- chain's numbers. Nothing here derives a claim from the height; it is
-- recorded so a holder fetching the receipt lands on the right block.
--
-- These transactions are OURS and already public (they are the anchor receipts
-- the /proof API publishes). The 80-byte headers are public chain data. Nothing
-- secret is embedded here.
--
-- §1.11A COMPLIANCE
-- -----------------
--   * DATA ROWS ONLY. Writes nothing to supabase_migrations.schema_migrations,
--     creates no soak_artifact rows, runs no migration repair.
--   * Idempotent: stable synthetic ids + ON CONFLICT, and every attestation
--     status transition is guarded by the status it moves FROM, so a re-run
--     repairs rather than duplicates and never touches an `anchored` row
--     (0314 makes anchored rows immutable).
--   * Obviously-synthetic identifiers (`rc-batch-0902`, `RC0902`, uuid prefix
--     `09020000-`/`0902c000-`, `*-Fixture` names, `.invalid` domains).
--   * ISOLATED RIGS ONLY. The guard block refuses a database that already holds
--     a production-scale anchor population OR any legally_binding_attestations
--     row that is not this fixture's.
--
-- DURABILITY AGAINST THE RIG'S OWN CRONS
-- --------------------------------------
-- Every fixture anchor is inserted SECURED with a non-null `chain_tx_id` and
-- `legal_hold = true`. SECURED is terminal for the broadcast recovery jobs, the
-- non-null txid keeps the rows outside `recover_stuck_broadcasts()` (0379), and
-- `legal_hold` excludes them from `autoConfirmMockAnchors()`,
-- `monitorStuckTransactions()`, `rebroadcastDroppedTransactions()` AND from
-- `detectReorgs()` (chain-maintenance.ts selects `legal_hold = false`) — which
-- also means the #2526 detect-reorgs probe cannot revert them. Same two
-- independent exclusions the baseline fixture documents, for the same reason.
--
-- INSERT ORDER
-- ------------
-- Anchors go in as PENDING, their `anchor_proofs` rows next, and only then are
-- the anchors promoted to SECURED. `enforce_secured_anchor_proof_complete()`
-- (0340, hardened by 0360) rejects a SECURED transition without merkle_root +
-- proof_path whenever the GUC `arkova.proof_enforce_secured_complete` is on;
-- every cohort here (a-uninspected included — `[]` is NOT NULL) satisfies the
-- batch-shape predicate, so this order is correct whether the rig has the GUC
-- on or off.
--
-- HOW TO RUN
-- ----------
--   psql "$RIG_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/staging/seed-rc-batch-0902-fixture.sql
--
-- Run it AFTER scripts/staging/seed-baseline-fixture.sql. Re-running is safe.
-- Requires pgcrypto in the `extensions` schema (Supabase default) — the roots
-- are computed with extensions.digest() so the SQL cannot drift from the
-- verifier's double-SHA256 rule by hand-typing a hash.
--
-- ROLLBACK / TEARDOWN (the rig is disposable, but for completeness):
--   DELETE FROM public.legally_binding_attestations
--     WHERE attestation_id LIKE 'ARK-ATT-RC0902-%'
--       AND status <> 'anchored';           -- anchored rows are immutable by
--                                           -- trigger; tear the rig down instead
--   DELETE FROM public.anchors WHERE metadata->>'_purpose' = 'rc-batch-0902';
--   -- anchor_proofs rows cascade via anchor_proofs_anchor_id_fkey.
--   DELETE FROM public.profiles      WHERE id IN ('09020000-0000-4000-8000-0000000000a1','09020000-0000-4000-8000-0000000000a2');
--   DELETE FROM auth.users           WHERE id IN ('09020000-0000-4000-8000-0000000000a1','09020000-0000-4000-8000-0000000000a2');
--   DELETE FROM public.organizations WHERE id IN ('09020000-0000-4000-8000-0000000000b1','09020000-0000-4000-8000-0000000000b2');

BEGIN;

-- Take the service_role fast-path through protect_anchor_status_transition()
-- so the SECURED promotion and the chain-data writes below are permitted.
-- Transaction-local; leaves no residue.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- 0. HARD GUARD — never run this against production or a production mirror.
--
-- The driver deny-checks the project ref, but the seed is run by psql against a
-- connection string and has no ref to check. Two signals are available from
-- inside the database and both are decisive: a production-scale anchor
-- population, and any legally_binding_attestations row that is not ours (the
-- table is empty in every environment; a foreign row means this is not a fresh
-- isolated rig).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  existing_anchors bigint;
  foreign_attestations bigint;
BEGIN
  SELECT count(*) INTO existing_anchors FROM public.anchors;
  IF existing_anchors > 10000 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: this database already holds % anchors. That is not a freshly provisioned isolated rig — refusing to seed (CLAUDE.md 1.11A).',
      existing_anchors;
  END IF;

  SELECT count(*) INTO foreign_attestations
    FROM public.legally_binding_attestations
   WHERE attestation_id NOT LIKE 'ARK-ATT-RC0902-%';
  IF foreign_attestations > 0 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: legally_binding_attestations holds % row(s) that are not this fixture. The table is empty in every environment; a populated one is not a fresh isolated rig — refusing to seed (CLAUDE.md 1.11A).',
      foreign_attestations;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Temp helpers (pg_temp — dropped with the session, no residue).
--   rc0902_sha256d      the verifier's hashing rule (utils/merkle-verify.ts):
--                       plain double-SHA256 over positional concatenation.
--   rc0902_reverse_hex  byte-reverse a hex string (block hashes are displayed
--                       in reverse byte order relative to sha256d(header)).
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.rc0902_sha256d(payload bytea) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(extensions.digest(extensions.digest(payload, 'sha256'), 'sha256'), 'hex');
$$;

CREATE FUNCTION pg_temp.rc0902_reverse_hex(h text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(substr(h, 2 * i - 1, 2), '' ORDER BY i DESC)
    FROM generate_series(1, length(h) / 2) AS i;
$$;

-- ---------------------------------------------------------------------------
-- 1. FK chain: two auth users -> identities -> orgs -> profiles.
--     Mirrors seed-baseline-fixture.sql with its own `0902…` ids so the fixtures
--     are independent and either can be torn down alone.
--     encrypted_password is derived at runtime from a throwaway random UUID —
--     no credential literal in source (SonarCloud S6418), and the rig never
--     accepts a login.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token,
  recovery_token, email_change, email_change_token_new,
  email_change_token_current, reauthentication_token, phone_change, phone_change_token
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '09020000-0000-4000-8000-0000000000a1',
    'authenticated', 'authenticated',
    'rc0902-meridian-user@seed-fixture.invalid',
    extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "RC0902 Meridian Fixture User"}',
    false, '',
    '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '09020000-0000-4000-8000-0000000000a2',
    'authenticated', 'authenticated',
    'rc0902-halcyon-user@seed-fixture.invalid',
    extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "RC0902 Halcyon Fixture User"}',
    false, '',
    '', '', '', '', '', '', ''
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
  id, user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at
)
SELECT v.id, v.user_id, v.identity_data::jsonb, 'email', v.user_id::text, NOW(), NOW(), NOW()
FROM (VALUES
  ('09020000-0000-4000-8000-0000000000d1'::uuid, '09020000-0000-4000-8000-0000000000a1'::uuid,
   '{"sub": "09020000-0000-4000-8000-0000000000a1", "email": "rc0902-meridian-user@seed-fixture.invalid"}'),
  ('09020000-0000-4000-8000-0000000000d2'::uuid, '09020000-0000-4000-8000-0000000000a2'::uuid,
   '{"sub": "09020000-0000-4000-8000-0000000000a2", "email": "rc0902-halcyon-user@seed-fixture.invalid"}')
) AS v(id, user_id, identity_data)
WHERE NOT EXISTS (
  SELECT 1 FROM auth.identities i
   WHERE i.provider = 'email' AND i.provider_id = v.user_id::text
)
ON CONFLICT (id) DO NOTHING;

-- Org A is VERIFIED: 0314's org gate refuses a `notarized`-type attestation for
-- any org that is not. Org B is UNVERIFIED so the driver sees both values of
-- `attesting_org.verified` should the park ever be lifted, and its attestations
-- are `witnessed`-type so the gate does not apply to them.
INSERT INTO public.organizations (
  id, legal_name, display_name, domain, verification_status
) VALUES
  ('09020000-0000-4000-8000-0000000000b1',
   'Meridian Notarial Fixture Org LLC', 'Meridian Notarial Fixture Org',
   'rc0902-meridian.invalid', 'VERIFIED'),
  ('09020000-0000-4000-8000-0000000000b2',
   'Halcyon Witness Fixture Org LLC', 'Halcyon Witness Fixture Org',
   'rc0902-halcyon.invalid', 'UNVERIFIED')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (
  id, email, full_name, role, org_id, is_public_profile, is_platform_admin
) VALUES
  ('09020000-0000-4000-8000-0000000000a1', 'rc0902-meridian-user@seed-fixture.invalid',
   'RC0902 Meridian Fixture User', 'ORG_ADMIN', '09020000-0000-4000-8000-0000000000b1', false, false),
  ('09020000-0000-4000-8000-0000000000a2', 'rc0902-halcyon-user@seed-fixture.invalid',
   'RC0902 Halcyon Fixture User', 'ORG_ADMIN', '09020000-0000-4000-8000-0000000000b2', false, false)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The real receipts, as data. One row per block.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE rc0902_blocks (
  block_tag    text   PRIMARY KEY,
  block_hash   text   NOT NULL,
  block_height bigint NOT NULL,
  block_time   bigint NOT NULL,
  header_hex   text   NOT NULL
) ON COMMIT DROP;

INSERT INTO rc0902_blocks (block_tag, block_hash, block_height, block_time, header_hex) VALUES
  ('A', '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960657, 1785637848,
   '00800020aa253b12e66471336476ae1d640598be225a1f1745700100000000000000000014befa43e06cc6e583a4f61ed2ae73759b28510a56ee40b667404746b2d0d53dd8ab6e6ad43a0217c7bf2963'),
  ('B', '00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2', 962144, 1786538405,
   '0040072088f1acb40b999996ca75c65f504512690db8d7f1422902000000000000000000507b90c09840409d0435ef25da8e1f6a01fa1609811b6cf748fb547962a058eda5697c6a3d35021772784679');

-- ---------------------------------------------------------------------------
-- 3. The cohort plan, as data. `expected_verdict` is the FIXTURE'S statement of
--    what the RC head must answer; the driver holds the same table in code and
--    refuses a fixture whose stamped expectation disagrees with its own.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE rc0902_plan (
  cohort           text    NOT NULL,
  slot             integer NOT NULL,
  org_tag          text    NOT NULL,
  anchor_id        uuid    NOT NULL,
  public_id        text    NOT NULL,
  chain_tx_id      text    NOT NULL,
  block_tag        text    NOT NULL REFERENCES rc0902_blocks(block_tag),
  expected_verdict text    NOT NULL,
  PRIMARY KEY (cohort, slot)
) ON COMMIT DROP;

INSERT INTO rc0902_plan (cohort, slot, org_tag, anchor_id, public_id, chain_tx_id, block_tag, expected_verdict) VALUES
  ('a-valid',       0, 'a', '0902c000-0000-4000-8000-000000000001', 'ARK-RC0902-A-VALID-0',
   '443f0482059aa57ecd1d719c6b88412edea329f73d913d8f98a644d45fbcf3ec', 'A', 'valid'),
  ('a-valid',       1, 'a', '0902c000-0000-4000-8000-000000000002', 'ARK-RC0902-A-VALID-1',
   '443f0482059aa57ecd1d719c6b88412edea329f73d913d8f98a644d45fbcf3ec', 'A', 'valid'),
  ('a-invalid',     0, 'a', '0902c000-0000-4000-8000-000000000003', 'ARK-RC0902-A-INVALID-0',
   '240a97417193e864e9fdf4206531945eb2ec4db1be92c127ab979f1b2b7b6f67', 'A', 'invalid'),
  ('a-invalid',     1, 'a', '0902c000-0000-4000-8000-000000000004', 'ARK-RC0902-A-INVALID-1',
   '240a97417193e864e9fdf4206531945eb2ec4db1be92c127ab979f1b2b7b6f67', 'A', 'invalid'),
  ('a-legacy',      0, 'a', '0902c000-0000-4000-8000-000000000005', 'ARK-RC0902-A-LEGACY-0',
   '65f73a4e6a7a9a5baa9809ad3a13c92d144d2a4b13267e1744fe72dfd32b493f', 'A', 'unverifiable'),
  ('a-legacy',      1, 'a', '0902c000-0000-4000-8000-000000000006', 'ARK-RC0902-A-LEGACY-1',
   '65f73a4e6a7a9a5baa9809ad3a13c92d144d2a4b13267e1744fe72dfd32b493f', 'A', 'unverifiable'),
  ('a-uninspected', 0, 'a', '0902c000-0000-4000-8000-000000000007', 'ARK-RC0902-A-UNINSPECTED-0',
   '89bc7802b33ddcee417c37d2797303378b150f96b38014ab35b6ef4d34069afc', 'A', 'unverifiable'),
  ('a-uninspected', 1, 'a', '0902c000-0000-4000-8000-000000000008', 'ARK-RC0902-A-UNINSPECTED-1',
   '89bc7802b33ddcee417c37d2797303378b150f96b38014ab35b6ef4d34069afc', 'A', 'unverifiable'),
  ('a-overlong',    0, 'a', '0902c000-0000-4000-8000-000000000009', 'ARK-RC0902-A-OVERLONG-0',
   'ae1fa6c8deeebac2647b09ec049312d7a209d6f5b2404d2404ad58e4078d1d0b', 'A', 'unverifiable'),
  ('b-valid',       0, 'b', '0902c000-0000-4000-8000-000000000010', 'ARK-RC0902-B-VALID-0',
   '57a509928e6f07ffeb3d07b1d90ee3f6949a29a8ef0fb952198821f510a77149', 'B', 'valid'),
  ('b-valid',       1, 'b', '0902c000-0000-4000-8000-000000000011', 'ARK-RC0902-B-VALID-1',
   '57a509928e6f07ffeb3d07b1d90ee3f6949a29a8ef0fb952198821f510a77149', 'B', 'valid');

-- Materialised row plan: one line per fixture anchor with its deterministic
-- fingerprint, owner and org. Everything downstream joins to this, so the
-- derivations exist in exactly one place.
CREATE TEMP TABLE rc0902_rows ON COMMIT DROP AS
SELECT
  p.cohort,
  p.slot,
  p.org_tag,
  p.anchor_id,
  p.public_id,
  p.chain_tx_id,
  p.expected_verdict,
  b.block_hash,
  b.block_height,
  b.block_time,
  b.header_hex,
  CASE p.org_tag WHEN 'a' THEN '09020000-0000-4000-8000-0000000000a1'::uuid
                 ELSE          '09020000-0000-4000-8000-0000000000a2'::uuid END AS user_id,
  CASE p.org_tag WHEN 'a' THEN '09020000-0000-4000-8000-0000000000b1'::uuid
                 ELSE          '09020000-0000-4000-8000-0000000000b2'::uuid END AS org_id,
  md5('rc0902-' || p.cohort || '-' || p.slot || '-hi')
    || md5('rc0902-' || p.cohort || '-' || p.slot || '-lo')               AS fingerprint
FROM rc0902_plan p
JOIN rc0902_blocks b ON b.block_tag = p.block_tag;

-- ---------------------------------------------------------------------------
-- 4. ANCHORS — inserted PENDING (see INSERT ORDER in the header).
-- ---------------------------------------------------------------------------
INSERT INTO public.anchors (
  id, public_id, user_id, org_id, filename, fingerprint, status,
  file_size, file_mime, description, metadata, legal_hold, created_at
)
SELECT
  r.anchor_id,
  r.public_id,
  r.user_id,
  r.org_id,
  'rc0902-' || r.cohort || '-' || r.slot || '.pdf',
  r.fingerprint,
  'PENDING',
  4096,
  'application/pdf',
  'rc/soak-batch-2026-09-02 fixture — synthetic document, real mainnet anchor receipt.',
  jsonb_build_object(
    '_fixture', true,
    '_synthetic', true,
    '_purpose', 'rc-batch-0902',
    '_cohort', r.cohort,
    '_slot', r.slot,
    '_org', r.org_tag,
    '_expected_verdict', r.expected_verdict
  ),
  true,
  NOW()
FROM rc0902_rows r
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. ANCHOR_PROOFS — one row per anchor, shaped per cohort.
--
--    The 2-leaf batches: root = sha256d(fp0 || fp1); slot 0's sibling is fp1
--    on the RIGHT, slot 1's sibling is fp0 on the LEFT — exactly the walk
--    verifyMerkleInclusion() performs. The wrong sibling for a-invalid and the
--    extra sibling for a-overlong are md5-derived 64-hex values that name no
--    real leaf.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE rc0902_proofs ON COMMIT DROP AS
WITH pairs AS (
  SELECT r0.cohort,
         r0.fingerprint AS fp0,
         r1.fingerprint AS fp1,
         pg_temp.rc0902_sha256d(decode(r0.fingerprint || r1.fingerprint, 'hex')) AS pair_root
    FROM rc0902_rows r0
    JOIN rc0902_rows r1 ON r1.cohort = r0.cohort AND r1.slot = 1
   WHERE r0.slot = 0
)
SELECT
  r.anchor_id,
  r.cohort,
  r.slot,
  r.chain_tx_id,
  r.block_hash,
  r.block_height,
  r.block_time,
  r.header_hex,
  r.fingerprint,
  -- batch_id: shared within a cohort (leaf_count = rows sharing it).
  'rc0902-' || r.cohort                                                    AS batch_id,
  CASE r.cohort
    WHEN 'a-valid'       THEN pr.pair_root
    WHEN 'b-valid'       THEN pr.pair_root
    WHEN 'a-invalid'     THEN pr.pair_root
    WHEN 'a-legacy'      THEN pr.pair_root
    WHEN 'a-uninspected' THEN r.fingerprint
    WHEN 'a-overlong'    THEN pg_temp.rc0902_sha256d(decode(
                              r.fingerprint || md5('rc0902-a-overlong-extra-sibling-hi')
                                            || md5('rc0902-a-overlong-extra-sibling-lo'), 'hex'))
  END                                                                       AS merkle_root,
  CASE r.cohort
    WHEN 'a-uninspected' THEN '[]'::jsonb
    WHEN 'a-overlong'    THEN jsonb_build_array(jsonb_build_object(
                              'hash', md5('rc0902-a-overlong-extra-sibling-hi')
                                   || md5('rc0902-a-overlong-extra-sibling-lo'),
                              'position', 'right'))
    WHEN 'a-invalid'     THEN jsonb_build_array(jsonb_build_object(
                              'hash', md5('rc0902-a-invalid-wrong-sibling-' || r.slot || '-hi')
                                   || md5('rc0902-a-invalid-wrong-sibling-' || r.slot || '-lo'),
                              'position', CASE r.slot WHEN 0 THEN 'right' ELSE 'left' END))
    ELSE                      jsonb_build_array(jsonb_build_object(
                              'hash', CASE r.slot WHEN 0 THEN pr.fp1 ELSE pr.fp0 END,
                              'position', CASE r.slot WHEN 0 THEN 'right' ELSE 'left' END))
  END                                                                       AS proof_path,
  CASE r.cohort
    WHEN 'a-legacy' THEN NULL
    ELSE r.slot
  END                                                                       AS merkle_index
FROM rc0902_rows r
LEFT JOIN pairs pr ON pr.cohort = r.cohort;

INSERT INTO public.anchor_proofs (
  anchor_id, receipt_id, block_height, block_timestamp,
  merkle_root, proof_path, merkle_index, batch_id,
  op_return_payload, block_hash, block_header
)
SELECT
  q.anchor_id,
  q.chain_tx_id,
  q.block_height,
  to_timestamp(q.block_time),
  q.merkle_root,
  q.proof_path,
  q.merkle_index,
  q.batch_id,
  decode('41524b56' || q.merkle_root, 'hex'),
  q.block_hash,
  decode(q.header_hex, 'hex')
FROM rc0902_proofs q
ON CONFLICT (anchor_id) DO UPDATE
SET receipt_id        = EXCLUDED.receipt_id,
    block_height      = EXCLUDED.block_height,
    block_timestamp   = EXCLUDED.block_timestamp,
    merkle_root       = EXCLUDED.merkle_root,
    proof_path        = EXCLUDED.proof_path,
    merkle_index      = EXCLUDED.merkle_index,
    batch_id          = EXCLUDED.batch_id,
    op_return_payload = EXCLUDED.op_return_payload,
    block_hash        = EXCLUDED.block_hash,
    block_header      = EXCLUDED.block_header;

-- ---------------------------------------------------------------------------
-- 6. PROMOTE to SECURED, now that every anchor has its proof row.
--    chain_timestamp is the REAL block time of the receipt's block, not NOW().
-- ---------------------------------------------------------------------------
UPDATE public.anchors a
SET status              = 'SECURED',
    chain_tx_id         = r.chain_tx_id,
    chain_block_height  = r.block_height,
    chain_block_hash    = r.block_hash,
    chain_timestamp     = to_timestamp(r.block_time),
    chain_confirmations = 100,
    legal_hold          = true,
    updated_at          = NOW()
FROM rc0902_rows r
WHERE a.id = r.anchor_id
  AND (a.status IS DISTINCT FROM 'SECURED'
       OR a.chain_tx_id IS DISTINCT FROM r.chain_tx_id
       OR a.chain_block_hash IS DISTINCT FROM r.block_hash
       OR a.legal_hold IS NOT TRUE);

-- ---------------------------------------------------------------------------
-- 7. LEGALLY BINDING ATTESTATIONS — all five statuses, both orgs.
--
--    0314's state machine inserts at `draft` only and walks
--    draft -> pending_notarization -> notarized -> anchored, with
--    requires_review reachable from any non-anchored state; anchored rows are
--    immutable. So: insert every row at draft, then step each row to its target
--    with UPDATEs guarded by the status it moves FROM. A re-run finds every row
--    already past those guards and touches nothing.
--
--    Every row carries a natural-person subject and a notary's name, commission
--    state and commission number — the PII the park must never let out.
-- ---------------------------------------------------------------------------
INSERT INTO public.legally_binding_attestations (
  attestation_id, attestation_type, attesting_org_id, attesting_org_name,
  subject_name, subject_credential_id, attestation_statement,
  notary_name, notary_commission_state, notary_commission_number,
  status
)
SELECT
  v.attestation_id,
  CASE v.org_tag WHEN 'a' THEN 'notarized' ELSE 'witnessed' END,
  CASE v.org_tag WHEN 'a' THEN '09020000-0000-4000-8000-0000000000b1'::uuid
                 ELSE          '09020000-0000-4000-8000-0000000000b2'::uuid END,
  CASE v.org_tag WHEN 'a' THEN 'Meridian Notarial Fixture Org' ELSE 'Halcyon Witness Fixture Org' END,
  CASE v.org_tag WHEN 'a' THEN 'Amara Okonkwo-Fixture' ELSE 'Tobias Lindqvist-Fixture' END,
  CASE v.org_tag WHEN 'a' THEN '0902c000-0000-4000-8000-000000000001'::uuid
                 ELSE          '0902c000-0000-4000-8000-000000000010'::uuid END,
  'Synthetic attestation statement for the rc-batch-0902 soak fixture (org '
    || v.org_tag || ', target status ' || v.target_status || '). Not a real attestation.',
  CASE v.org_tag WHEN 'a' THEN 'Priya Raghunathan-Fixture' ELSE 'Elena Marchetti-Fixture' END,
  CASE v.org_tag WHEN 'a' THEN 'TX' ELSE 'NV' END,
  CASE v.org_tag WHEN 'a' THEN 'RC0902-COMM-A-7731' ELSE 'RC0902-COMM-B-8842' END,
  'draft'
FROM (VALUES
  ('ARK-ATT-RC0902-A-DRAFT',     'a', 'draft'),
  ('ARK-ATT-RC0902-A-PENDING',   'a', 'pending_notarization'),
  ('ARK-ATT-RC0902-A-REVIEW',    'a', 'requires_review'),
  ('ARK-ATT-RC0902-A-NOTARIZED', 'a', 'notarized'),
  ('ARK-ATT-RC0902-A-ANCHORED',  'a', 'anchored'),
  ('ARK-ATT-RC0902-B-DRAFT',     'b', 'draft'),
  ('ARK-ATT-RC0902-B-PENDING',   'b', 'pending_notarization'),
  ('ARK-ATT-RC0902-B-REVIEW',    'b', 'requires_review'),
  ('ARK-ATT-RC0902-B-NOTARIZED', 'b', 'notarized'),
  ('ARK-ATT-RC0902-B-ANCHORED',  'b', 'anchored')
) AS v(attestation_id, org_tag, target_status)
ON CONFLICT (attestation_id) DO NOTHING;

-- draft -> requires_review (the flagged rows)
UPDATE public.legally_binding_attestations
   SET status = 'requires_review'
 WHERE attestation_id IN ('ARK-ATT-RC0902-A-REVIEW', 'ARK-ATT-RC0902-B-REVIEW')
   AND status = 'draft';

-- draft -> pending_notarization (everything that goes further than draft)
UPDATE public.legally_binding_attestations
   SET status = 'pending_notarization'
 WHERE attestation_id IN (
         'ARK-ATT-RC0902-A-PENDING', 'ARK-ATT-RC0902-A-NOTARIZED', 'ARK-ATT-RC0902-A-ANCHORED',
         'ARK-ATT-RC0902-B-PENDING', 'ARK-ATT-RC0902-B-NOTARIZED', 'ARK-ATT-RC0902-B-ANCHORED')
   AND status = 'draft';

-- pending_notarization -> notarized
UPDATE public.legally_binding_attestations
   SET status = 'notarized',
       notarization_completed_at = NOW(),
       docusign_completed_at = NOW()
 WHERE attestation_id IN (
         'ARK-ATT-RC0902-A-NOTARIZED', 'ARK-ATT-RC0902-A-ANCHORED',
         'ARK-ATT-RC0902-B-NOTARIZED', 'ARK-ATT-RC0902-B-ANCHORED')
   AND status = 'pending_notarization';

-- notarized -> anchored, binding each org's row to ITS OWN a-valid/b-valid
-- slot-0 anchor (per-org attribution) and stamping the real block time.
UPDATE public.legally_binding_attestations t
   SET status = 'anchored',
       anchor_id = r.anchor_id,
       anchor_timestamp = to_timestamp(r.block_time),
       public_verification_url = 'https://app.arkova.ai/verify/attestation/' || t.attestation_id
  FROM rc0902_rows r
 WHERE r.slot = 0
   AND ((t.attestation_id = 'ARK-ATT-RC0902-A-ANCHORED' AND r.cohort = 'a-valid')
     OR (t.attestation_id = 'ARK-ATT-RC0902-B-ANCHORED' AND r.cohort = 'b-valid'))
   AND t.status = 'notarized';

-- ---------------------------------------------------------------------------
-- POST-CONDITIONS — ENFORCED, NOT DOCUMENTED.
--
-- Every one of these is a property the driver's assertions silently assume. A
-- fixture that violates one does not fail loudly at seed time and instead
-- produces a soak whose evidence is quietly meaningless — the failure mode this
-- whole exercise exists to prevent. Any RAISE rolls the seed back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_anchors            integer;
  n_secured_held       integer;
  n_bad_txid           integer;
  n_valid_recompute    integer;
  n_invalid_recompute  integer;
  n_legacy_ok          integer;
  n_uninspected_ok     integer;
  n_overlong_ok        integer;
  n_bad_opreturn       integer;
  n_bad_header         integer;
  n_bad_bundle_prereq  integer;
  n_expected_stamped   integer;
  flag_enabled         boolean;
  n_att                integer;
  n_att_pii            integer;
  n_att_cross_org      integer;
  n_att_foreign        integer;
  blk                  record;
BEGIN
  -- 11 fixture anchors, all SECURED, all on legal hold, all on a real 64-hex receipt.
  SELECT count(*) INTO n_anchors
    FROM public.anchors WHERE metadata->>'_purpose' = 'rc-batch-0902';
  SELECT count(*) INTO n_secured_held
    FROM public.anchors
   WHERE metadata->>'_purpose' = 'rc-batch-0902'
     AND status = 'SECURED' AND legal_hold = true AND deleted_at IS NULL;
  IF n_anchors <> 11 OR n_secured_held <> 11 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % fixture anchors, % of them SECURED+legal_hold (expected 11/11)',
      n_anchors, n_secured_held;
  END IF;

  SELECT count(*) INTO n_bad_txid
    FROM public.anchors a
   WHERE a.metadata->>'_purpose' = 'rc-batch-0902'
     AND (a.chain_tx_id !~ '^[0-9a-f]{64}$' OR a.chain_block_hash !~ '^[0-9a-f]{64}$'
          OR a.chain_timestamp IS NULL OR a.chain_block_height IS NULL);
  IF n_bad_txid > 0 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % anchor(s) lack a well-formed receipt (txid / block hash / height / timestamp)',
      n_bad_txid;
  END IF;

  -- The embedded headers must BE the blocks they claim to be:
  -- reverse(sha256d(header)) == block_hash, and the header must be 80 bytes.
  FOR blk IN SELECT * FROM rc0902_blocks LOOP
    IF length(decode(blk.header_hex, 'hex')) <> 80
       OR pg_temp.rc0902_reverse_hex(pg_temp.rc0902_sha256d(decode(blk.header_hex, 'hex'))) <> blk.block_hash THEN
      RAISE EXCEPTION
        'seed-rc-batch-0902-fixture: block % header does not hash to its block hash — the embedded header is not the real block',
        blk.block_tag;
    END IF;
  END LOOP;

  -- valid cohorts: the stored branch must genuinely recompute to the stored root
  -- (single sibling; sha256d over the positional concatenation).
  SELECT count(*) INTO n_valid_recompute
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_purpose' = 'rc-batch-0902'
     AND a.metadata->>'_cohort' IN ('a-valid', 'b-valid')
     AND jsonb_array_length(p.proof_path) = 1
     AND p.merkle_index = (a.metadata->>'_slot')::integer
     AND p.merkle_root = CASE p.proof_path->0->>'position'
           WHEN 'right' THEN pg_temp.rc0902_sha256d(decode(a.fingerprint || (p.proof_path->0->>'hash'), 'hex'))
           ELSE              pg_temp.rc0902_sha256d(decode((p.proof_path->0->>'hash') || a.fingerprint, 'hex'))
         END;
  IF n_valid_recompute <> 4 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: only % of 4 valid-cohort rows recompute to their stored root — the `valid` vector would not verify',
      n_valid_recompute;
  END IF;

  -- a-invalid: the stored sibling must NOT recompute to the (true) root.
  SELECT count(*) INTO n_invalid_recompute
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_cohort' = 'a-invalid'
     AND jsonb_array_length(p.proof_path) = 1
     AND p.merkle_index = (a.metadata->>'_slot')::integer
     AND p.merkle_root <> CASE p.proof_path->0->>'position'
           WHEN 'right' THEN pg_temp.rc0902_sha256d(decode(a.fingerprint || (p.proof_path->0->>'hash'), 'hex'))
           ELSE              pg_temp.rc0902_sha256d(decode((p.proof_path->0->>'hash') || a.fingerprint, 'hex'))
         END;
  IF n_invalid_recompute <> 2 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: only % of 2 a-invalid rows fail the recompute — the `invalid` vector would not fail',
      n_invalid_recompute;
  END IF;

  -- a-legacy: correct branch, NO merkle_index (guard cannot arm).
  SELECT count(*) INTO n_legacy_ok
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_cohort' = 'a-legacy'
     AND p.merkle_index IS NULL
     AND jsonb_array_length(p.proof_path) = 1
     AND p.merkle_root = CASE p.proof_path->0->>'position'
           WHEN 'right' THEN pg_temp.rc0902_sha256d(decode(a.fingerprint || (p.proof_path->0->>'hash'), 'hex'))
           ELSE              pg_temp.rc0902_sha256d(decode((p.proof_path->0->>'hash') || a.fingerprint, 'hex'))
         END;
  IF n_legacy_ok <> 2 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: only % of 2 a-legacy rows have a verifying branch with NULL merkle_index',
      n_legacy_ok;
  END IF;

  -- a-uninspected: empty branch, root == own leaf, index present, TWO rows share
  -- the batch (so leaf_count = 2 and depth = 1 != 0).
  SELECT count(*) INTO n_uninspected_ok
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_cohort' = 'a-uninspected'
     AND p.proof_path = '[]'::jsonb
     AND p.merkle_root = a.fingerprint
     AND p.merkle_index = (a.metadata->>'_slot')::integer
     AND (SELECT count(*) FROM public.anchor_proofs x WHERE x.batch_id = p.batch_id) = 2;
  IF n_uninspected_ok <> 2 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: only % of 2 a-uninspected rows have the empty-branch / 2-row-batch shape the #2527 head-2 rule is exercised by',
      n_uninspected_ok;
  END IF;

  -- a-overlong: ONE row in its batch (leaf_count 1, depth 0) but a 1-sibling
  -- branch that still recomputes to the root.
  SELECT count(*) INTO n_overlong_ok
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_cohort' = 'a-overlong'
     AND p.merkle_index = 0
     AND jsonb_array_length(p.proof_path) = 1
     AND (SELECT count(*) FROM public.anchor_proofs x WHERE x.batch_id = p.batch_id) = 1
     AND p.merkle_root = pg_temp.rc0902_sha256d(decode(a.fingerprint || (p.proof_path->0->>'hash'), 'hex'));
  IF n_overlong_ok <> 1 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: the a-overlong row does not have the single-row-batch / 1-sibling / recomputing shape';
  END IF;

  -- Every row's OP_RETURN must commit ITS OWN root in the canonical shape, or
  -- buildProofBundle refuses to emit a bundle.
  SELECT count(*) INTO n_bad_opreturn
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_purpose' = 'rc-batch-0902'
     AND encode(p.op_return_payload, 'hex') IS DISTINCT FROM ('41524b56' || p.merkle_root);
  IF n_bad_opreturn > 0 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % row(s) carry an OP_RETURN payload that does not commit their own merkle_root',
      n_bad_opreturn;
  END IF;

  -- Bundle prerequisites on every row: 80-byte header, 64-hex block hash,
  -- receipt id equals the anchor's txid, block height agrees with the anchor.
  SELECT count(*) INTO n_bad_header
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_purpose' = 'rc-batch-0902'
     AND (length(p.block_header) <> 80 OR p.block_hash !~ '^[0-9a-f]{64}$'
          OR p.receipt_id IS DISTINCT FROM a.chain_tx_id
          OR p.block_height IS DISTINCT FROM a.chain_block_height::integer
          OR p.block_hash IS DISTINCT FROM a.chain_block_hash);
  IF n_bad_header > 0 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % row(s) fail the bitcoin-tree prerequisites (header/hash/receipt/height coherence)',
      n_bad_header;
  END IF;

  -- The valid cohorts must satisfy buildProofBundle's receipt layer in full.
  SELECT count(*) INTO n_bad_bundle_prereq
    FROM public.anchors a
   WHERE a.metadata->>'_cohort' IN ('a-valid', 'b-valid')
     AND (a.chain_tx_id IS NULL OR a.chain_block_height IS NULL OR a.chain_timestamp IS NULL);
  IF n_bad_bundle_prereq > 0 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % valid-cohort anchor(s) lack the receipt fields buildProofBundle requires',
      n_bad_bundle_prereq;
  END IF;

  -- The stamped expectation table must be the one the driver holds.
  SELECT count(*) INTO n_expected_stamped
    FROM public.anchors a
   WHERE a.metadata->>'_purpose' = 'rc-batch-0902'
     AND a.metadata->>'_expected_verdict' = CASE a.metadata->>'_cohort'
           WHEN 'a-valid' THEN 'valid' WHEN 'b-valid' THEN 'valid'
           WHEN 'a-invalid' THEN 'invalid'
           ELSE 'unverifiable' END;
  IF n_expected_stamped <> 11 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % of 11 anchors carry the expected verdict their cohort implies',
      n_expected_stamped;
  END IF;

  -- The driver reads /api/v1/verify/:publicId/proof. `get_flag` fails CLOSED on
  -- an absent row, so without an ENABLED flag every request 503s before reaching
  -- application code. The BASELINE seed owns this row; this file only refuses to
  -- certify a fixture whose /api/v1 is dark.
  SELECT f.enabled INTO flag_enabled
    FROM public.switchboard_flags f
   WHERE f.flag_key = 'ENABLE_VERIFICATION_API';
  IF flag_enabled IS NOT TRUE THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: ENABLE_VERIFICATION_API is % — /api/v1 would be dark on this rig. Run scripts/staging/seed-baseline-fixture.sql first (it owns this row).',
      COALESCE(flag_enabled::text, 'absent');
  END IF;

  -- Attestations: exactly the ten fixture rows, each at its target status.
  SELECT count(*) INTO n_att
    FROM public.legally_binding_attestations t
   WHERE t.attestation_id LIKE 'ARK-ATT-RC0902-%'
     AND t.status = CASE
           WHEN t.attestation_id LIKE '%-DRAFT'     THEN 'draft'
           WHEN t.attestation_id LIKE '%-PENDING'   THEN 'pending_notarization'
           WHEN t.attestation_id LIKE '%-REVIEW'    THEN 'requires_review'
           WHEN t.attestation_id LIKE '%-NOTARIZED' THEN 'notarized'
           WHEN t.attestation_id LIKE '%-ANCHORED'  THEN 'anchored'
         END;
  IF n_att <> 10 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % of 10 attestation rows sit at their target status',
      n_att;
  END IF;

  -- Every row carries the PII the park is measured against.
  SELECT count(*) INTO n_att_pii
    FROM public.legally_binding_attestations t
   WHERE t.attestation_id LIKE 'ARK-ATT-RC0902-%'
     AND t.subject_name LIKE '%-Fixture'
     AND t.notary_name LIKE '%-Fixture'
     AND t.notary_commission_number LIKE 'RC0902-COMM-%';
  IF n_att_pii <> 10 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % of 10 attestation rows carry the subject/notary PII the K4 sweep searches for',
      n_att_pii;
  END IF;

  -- Anchored rows must reference an anchor of THEIR OWN org, or the per-org
  -- attribution check has nothing to attribute.
  SELECT count(*) INTO n_att_cross_org
    FROM public.legally_binding_attestations t
    JOIN public.anchors a ON a.id = t.anchor_id
   WHERE t.attestation_id LIKE 'ARK-ATT-RC0902-%'
     AND t.status = 'anchored'
     AND a.org_id IS DISTINCT FROM t.attesting_org_id;
  IF n_att_cross_org > 0 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % anchored attestation(s) reference another org''s anchor',
      n_att_cross_org;
  END IF;

  SELECT count(*) INTO n_att_foreign
    FROM public.legally_binding_attestations t
   WHERE t.attestation_id NOT LIKE 'ARK-ATT-RC0902-%';
  IF n_att_foreign > 0 THEN
    RAISE EXCEPTION
      'seed-rc-batch-0902-fixture: % foreign attestation row(s) present after seeding',
      n_att_foreign;
  END IF;

  RAISE NOTICE
    'seed-rc-batch-0902-fixture: 11 SECURED fixture anchors (a-valid 2 / a-invalid 2 / a-legacy 2 / a-uninspected 2 / a-overlong 1 / b-valid 2) on real receipts with verified headers; 10 attestation rows across all five statuses in two orgs; ENABLE_VERIFICATION_API enabled';
END;
$$;

COMMIT;
