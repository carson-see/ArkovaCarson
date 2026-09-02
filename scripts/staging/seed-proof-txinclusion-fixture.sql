-- scripts/staging/seed-proof-txinclusion-fixture.sql
--
-- PR #2524 (proof tx-inclusion, T3) soak fixture for ISOLATED rigs.
--
-- SEPARATE FILE ON PURPOSE. `seed-baseline-fixture.sql` is the SHARED
-- provisioning baseline every rig runs, and its post-condition block is what
-- keeps `clean_mirror` honest for all of them. This file is additive, PR-owned,
-- and runs AFTER the baseline. Do not fold it into the baseline.
--
-- WHY A FIXTURE AT ALL
-- --------------------
-- The standing rig holds 10 anchors and 1 proof row. That cannot exercise a
-- cursor sweep (one page covers everything, so advance and wrap are
-- unobservable) and it cannot exercise the batched `.in()` write (the 200-value
-- `chunkForInFilter` cap is never approached). A soak on that data would be
-- 48 hours of worker-health evidence for a PR about paging and chunking.
--
-- WHAT IT BUILDS
-- --------------
--   wedge   120 anchors  — sort FIRST in the anchor_id keyspace, share ONE real
--                          txid, and each records a DIFFERENT, WRONG block_hash.
--   bulk    450 anchors  — ONE real txid. 450 > the 200-value chunk cap, so the
--                          confirmation write for this group is necessarily more
--                          than one PostgREST `.in()` statement.
--   spread 2430 anchors  — 6 real txids x 405. Bulk volume so the candidate set
--                          (3000 rows) exceeds the default 2000-row sweep page
--                          and the sweep needs more than one page to finish.
--
-- THE WEDGE IS THE INSTRUMENT, NOT DECORATION
-- -------------------------------------------
-- The H1 defect this PR repaired was a sweep that could not advance: a page of
-- rows that can never complete kept its position and came back first on every
-- run, forever. To OBSERVE advance you need rows that (a) always match the scan
-- predicate and (b) never complete — and whose presence in a page is visible in
-- a counter. The wedge is exactly that:
--
--   * Its txid is real, so `fetchConfirmationProof` returns `confirmed` and the
--     job reaches the per-anchor K1 reorg gate.
--   * Each row records a DIFFERENT wrong `block_hash`, so
--     `unanimousBlockHash()` returns null, the cheap group-level short-circuit
--     stays disarmed, and the per-anchor gate actually runs. (A wedge whose rows
--     AGREED on one wrong hash would arm the group guard, come back `stale`, and
--     increment `txStale` instead — the per-anchor counter would stay 0 and the
--     instrument would read nothing.)
--   * That gate then increments `anchorsBlockMismatch` once per wedge row and
--     writes nothing, so the rows stay candidates forever.
--
-- Net effect: `anchorsBlockMismatch > 0` means "this page included the head of
-- the keyspace". A build that re-returns the same page reports it on EVERY tick;
-- the fixed build reports it on the first tick of a sweep and again only after
-- the wrap. `services/worker/scripts/pr2524-proof-txinclusion-driver.ts`
-- (A2/A3) reads exactly that.
--
-- REAL MAINNET TRANSACTIONS — AND WHERE THEY CAME FROM
-- ----------------------------------------------------
-- Synthetic txids make the B0 fold guard untestable: `gettxoutproof` cannot
-- resolve them, so `parseTxOutProof` is never fed a real partial merkle tree and
-- the branch it emits is never folded against a real block merkleroot. Every
-- txid below is a REAL Arkova mainnet anchoring transaction, read (SELECT only,
-- never written) from the production project `vzwyaatejekddvltxyye` on
-- 2026-09-02 with:
--
--   SELECT p.block_hash, p.block_height, a.chain_tx_id, count(*)
--     FROM public.anchor_proofs p
--     JOIN public.anchors a ON a.id = p.anchor_id
--    WHERE p.block_hash IS NOT NULL AND a.status = 'SECURED'
--    GROUP BY 1,2,3 ORDER BY 2 DESC;
--
-- To refresh them, re-run that query and pick a block carrying at least TWO
-- distinct txids. Two-in-one-block is a hard requirement, not a convenience:
-- the driver's A6 negative control asks `gettxoutproof` for a proof over TWO
-- txids in the same block — the multi-match class whose emitted branch used to
-- come out longer than the tree is tall and fold to the wrong root while the
-- pass-1 verified-root check still passed. Without a second txid in the same
-- block, B0's reason for existing is never exercised.
--
-- Block A  000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045 @ 960655
--          carries 7 Arkova txids; 1 is used for `bulk`, 6 for `spread`.
-- Block B  00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2 @ 962141
--          supplies the wedge txid, deliberately from a DIFFERENT block so a
--          wedge row can never be repaired by a bulk/spread row's proof.
--
-- These transactions are OURS and already public (they are the anchor receipts
-- the /proof API publishes). Nothing secret is embedded here.
--
-- §1.11A COMPLIANCE
-- -----------------
--   * DATA ROWS ONLY. Writes nothing to supabase_migrations.schema_migrations,
--     creates no soak_artifact rows, runs no migration repair.
--   * Idempotent: stable synthetic ids + ON CONFLICT, so re-running repairs
--     rather than duplicates.
--   * Obviously-synthetic identifiers (`pr2524-fixture`, uuid prefixes
--     `2524a…`/`2524b…`) so the rows can never be mistaken for real data.
--   * ISOLATED RIGS ONLY. This inserts thousands of SECURED anchors carrying
--     real mainnet txids; on prod or on the shared rig that is contamination.
--     The guard block below REFUSES to run when the database already holds a
--     production-scale anchor population.
--
-- DURABILITY AGAINST THE RIG'S OWN CRONS
-- --------------------------------------
-- Every fixture anchor is inserted SECURED with a non-null `chain_tx_id` and
-- `legal_hold = true`. SECURED is terminal for the broadcast recovery jobs, the
-- non-null txid puts the rows outside `recover_stuck_broadcasts()` (0379), and
-- `legal_hold` excludes them from `autoConfirmMockAnchors()`,
-- `monitorStuckTransactions()` and `rebroadcastDroppedTransactions()`. Same two
-- independent exclusions the baseline fixture documents, for the same reason.
--
-- INSERT ORDER
-- ------------
-- Anchors go in as PENDING, their `anchor_proofs` rows next, and only then are
-- the anchors promoted to SECURED. `enforce_secured_anchor_proof_complete()`
-- (0340) rejects a SECURED anchor with no complete proof row whenever the GUC
-- `arkova.proof_enforce_secured_complete` is on; seeding in this order is
-- correct whether the rig has it on or off, instead of depending on a default.
--
-- THE APP-TREE HALF IS GENUINE, NOT PLACEHOLDER
-- ---------------------------------------------
-- Each anchor is its own single-leaf batch: `proof_path = []`,
-- `merkle_index = 0`, `merkle_root = fingerprint`, and `batch_id` unique per
-- anchor so the `/proof` leaf-count query returns exactly 1.
-- `verifyMerkleInclusion` treats an empty branch as a single-leaf tree and
-- requires `root == leaf`, so these proofs genuinely VERIFY — `/proof` answers
-- `verified: true` rather than publishing a bundle over a fabricated tree. The
-- `op_return_payload` is the canonical `ARKV` tag plus that same root, which is
-- what `canonicalOpReturn` demands before it will emit a bundle at all.
--
-- HOW TO RUN
-- ----------
--   psql "$RIG_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/staging/seed-proof-txinclusion-fixture.sql
--
-- Run it AFTER scripts/staging/seed-baseline-fixture.sql and AFTER migration
-- 0427 is applied to the rig. Re-running is safe and re-arms the fixture.
--
-- ROLLBACK / TEARDOWN (the rig is disposable, but for completeness):
--   DELETE FROM public.anchors WHERE metadata->>'_purpose' = 'pr2524-proof-txinclusion';
--   -- anchor_proofs rows cascade via anchor_proofs_anchor_id_fkey.
--   DELETE FROM public.profiles     WHERE id = '25240000-0000-4000-8000-0000000000a1';
--   DELETE FROM auth.users          WHERE id = '25240000-0000-4000-8000-0000000000a1';
--   DELETE FROM public.organizations WHERE id = '25240000-0000-4000-8000-0000000000b1';

BEGIN;

-- Take the service_role fast-path through protect_anchor_status_transition()
-- so the SECURED promotion and the chain-data writes below are permitted.
-- Transaction-local; leaves no residue.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- 0. HARD GUARD — never run this against production or a production mirror.
--
-- The driver deny-checks the project ref, but the seed is run by psql against a
-- connection string and has no ref to check. A production-scale anchor
-- population is the one signal available from inside the database, and it is
-- decisive: an isolated rig provisioned minutes ago holds a handful of rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  existing_anchors bigint;
BEGIN
  SELECT count(*) INTO existing_anchors FROM public.anchors;
  IF existing_anchors > 10000 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: this database already holds % anchors. That is not a freshly provisioned isolated rig — refusing to seed (CLAUDE.md 1.11A).',
      existing_anchors;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. FK chain: auth user -> identity -> org -> profile.
--     Mirrors seed-baseline-fixture.sql, with its own `2524…` ids so the two
--     fixtures are independent and either can be torn down alone.
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
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '25240000-0000-4000-8000-0000000000a1',
  'authenticated', 'authenticated',
  'pr2524-fixture-user@seed-fixture.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  NOW(), NOW(), NOW(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "PR2524 Fixture User"}',
  false, '',
  '', '', '', '', '', '', ''
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
  id, user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at
)
SELECT
  '25240000-0000-4000-8000-0000000000d1',
  '25240000-0000-4000-8000-0000000000a1',
  '{"sub": "25240000-0000-4000-8000-0000000000a1", "email": "pr2524-fixture-user@seed-fixture.invalid"}'::jsonb,
  'email',
  '25240000-0000-4000-8000-0000000000a1',
  NOW(), NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM auth.identities
  WHERE provider = 'email'
    AND provider_id = '25240000-0000-4000-8000-0000000000a1'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (
  id, legal_name, display_name, domain, verification_status
) VALUES (
  '25240000-0000-4000-8000-0000000000b1',
  'PR2524 Proof Fixture Org LLC',
  'PR2524 Proof Fixture Org',
  'pr2524-fixture.invalid',
  'UNVERIFIED'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (
  id, email, full_name, role, org_id, is_public_profile, is_platform_admin
) VALUES (
  '25240000-0000-4000-8000-0000000000a1',
  'pr2524-fixture-user@seed-fixture.invalid',
  'PR2524 Fixture User',
  'ORG_ADMIN',
  '25240000-0000-4000-8000-0000000000b1',
  false,
  false
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The cohort plan, as data.
--
--    Expressed as a temp table so the three cohorts are described once and the
--    anchor / proof inserts below are one statement each instead of three.
--    `id_prefix` fixes the sort position in the anchor_id keyspace, which is the
--    scan's ORDER BY and therefore the sweep order: wedge first, then bulk,
--    then spread.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE pr2524_plan (
  cohort        text    NOT NULL,
  slot          integer NOT NULL,   -- distinguishes txids inside one cohort
  rows_in_slot  integer NOT NULL,
  id_prefix     text    NOT NULL,
  chain_tx_id   text    NOT NULL,
  block_hash    text    NOT NULL,
  block_height  bigint  NOT NULL
) ON COMMIT DROP;

INSERT INTO pr2524_plan (cohort, slot, rows_in_slot, id_prefix, chain_tx_id, block_hash, block_height) VALUES
  -- WEDGE — block B, one txid, 120 rows, sorts first.
  ('wedge',  0, 120, '00000000-0000-4000-8000-',
   '57a509928e6f07ffeb3d07b1d90ee3f6949a29a8ef0fb952198821f510a77149',
   '00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2', 962141),
  -- BULK — block A, ONE txid, 450 rows (> the 200-value .in() chunk cap).
  ('bulk',   0, 450, '2524a000-0000-4000-8000-',
   '443f0482059aa57ecd1d719c6b88412edea329f73d913d8f98a644d45fbcf3ec',
   '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960655),
  -- SPREAD — block A, 6 further txids x 405 rows = 2430.
  ('spread', 0, 405, '2524b000-0000-4000-8000-',
   '240a97417193e864e9fdf4206531945eb2ec4db1be92c127ab979f1b2b7b6f67',
   '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960655),
  ('spread', 1, 405, '2524b001-0000-4000-8000-',
   '65f73a4e6a7a9a5baa9809ad3a13c92d144d2a4b13267e1744fe72dfd32b493f',
   '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960655),
  ('spread', 2, 405, '2524b002-0000-4000-8000-',
   '89bc7802b33ddcee417c37d2797303378b150f96b38014ab35b6ef4d34069afc',
   '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960655),
  ('spread', 3, 405, '2524b003-0000-4000-8000-',
   'ae1fa6c8deeebac2647b09ec049312d7a209d6f5b2404d2404ad58e4078d1d0b',
   '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960655),
  ('spread', 4, 405, '2524b004-0000-4000-8000-',
   'b6c6881ddfa43086c424b29584b9ffb1a3876c4fa3115ab1575fc5a4db6f10d6',
   '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960655),
  ('spread', 5, 405, '2524b005-0000-4000-8000-',
   'cfca5d9bb870044208b1fca6eb60a92305d08b9810774ec3fd1dc4a49264f6dd',
   '000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045', 960655);

-- Materialised row plan: one line per fixture anchor, with its deterministic id
-- and fingerprint. Everything downstream joins to this, so the id derivation
-- exists in exactly one place.
CREATE TEMP TABLE pr2524_rows ON COMMIT DROP AS
SELECT
  p.cohort,
  p.slot,
  g.n,
  (p.id_prefix || lpad(to_hex(g.n), 12, '0'))::uuid                       AS anchor_id,
  p.chain_tx_id,
  p.block_hash,
  p.block_height,
  md5('pr2524-' || p.cohort || '-' || p.slot || '-' || g.n || '-hi')
    || md5('pr2524-' || p.cohort || '-' || p.slot || '-' || g.n || '-lo')  AS fingerprint
FROM pr2524_plan p
CROSS JOIN LATERAL generate_series(1, p.rows_in_slot) AS g(n);

-- ---------------------------------------------------------------------------
-- 3. ANCHORS — inserted PENDING (see INSERT ORDER in the header).
-- ---------------------------------------------------------------------------
INSERT INTO public.anchors (
  id, user_id, org_id, filename, fingerprint, status,
  file_size, file_mime, description, metadata, legal_hold, created_at
)
SELECT
  r.anchor_id,
  '25240000-0000-4000-8000-0000000000a1',
  '25240000-0000-4000-8000-0000000000b1',
  'pr2524-' || r.cohort || '-' || r.slot || '-' || r.n || '.pdf',
  r.fingerprint,
  'PENDING',
  4096,
  'application/pdf',
  'PR2524 tx-inclusion soak fixture — synthetic document, real mainnet anchor receipt.',
  jsonb_build_object(
    '_fixture', true,
    '_synthetic', true,
    '_purpose', 'pr2524-proof-txinclusion',
    '_cohort', r.cohort,
    '_slot', r.slot
  ),
  true,
  NOW()
FROM pr2524_rows r
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. ANCHOR_PROOFS — genuine single-leaf app-tree, EMPTY bitcoin-tree.
--
--    block_header / tx_inclusion_branch / tx_block_index are NULL: filling them
--    is the job under test. `block_hash` is NULL for the completable cohorts (a
--    first population records none) and, for the wedge, a DISTINCT well-formed
--    hash per row that is not the block its tx is in — see THE WEDGE IS THE
--    INSTRUMENT above.
-- ---------------------------------------------------------------------------
INSERT INTO public.anchor_proofs (
  anchor_id, receipt_id, block_height, block_timestamp,
  merkle_root, proof_path, merkle_index, batch_id,
  op_return_payload, block_hash, block_header,
  tx_inclusion_branch, tx_block_index
)
SELECT
  r.anchor_id,
  r.chain_tx_id,
  r.block_height,
  NOW(),
  r.fingerprint,
  '[]'::jsonb,
  0,
  'pr2524-' || r.anchor_id::text,
  decode('41524b56' || r.fingerprint, 'hex'),
  CASE
    WHEN r.cohort = 'wedge'
      -- Deterministic, well-formed, and not this tx's block. Distinct per row so
      -- unanimousBlockHash() cannot arm the group-level short-circuit.
      THEN md5('pr2524-wedge-wrongblock-' || r.n || '-hi')
             || md5('pr2524-wedge-wrongblock-' || r.n || '-lo')
    ELSE NULL
  END,
  NULL,
  NULL,
  NULL
FROM pr2524_rows r
ON CONFLICT (anchor_id) DO UPDATE
SET receipt_id          = EXCLUDED.receipt_id,
    block_height        = EXCLUDED.block_height,
    merkle_root         = EXCLUDED.merkle_root,
    proof_path          = EXCLUDED.proof_path,
    merkle_index        = EXCLUDED.merkle_index,
    batch_id            = EXCLUDED.batch_id,
    op_return_payload   = EXCLUDED.op_return_payload,
    -- RE-ARM: clear the bitcoin-tree evidence so a re-run restores a fixture
    -- that a previous cycle completed. This is the same clearing the driver
    -- does per cycle; running the file again is the manual equivalent.
    block_hash          = EXCLUDED.block_hash,
    block_header        = NULL,
    tx_inclusion_branch = NULL,
    tx_block_index      = NULL;

-- ---------------------------------------------------------------------------
-- 5. PROMOTE to SECURED, now that every anchor has a complete app-tree proof.
--
--    `chain_timestamp` is NOW(), NOT the real time of block 960655/962141. It
--    exists because `buildProofBundle` refuses to emit a bundle without one; no
--    assertion in the driver reads it, and nothing derives a claim from it. It
--    is synthetic like the documents themselves — only the txid, block hash and
--    block height are real, because only those three have to be real for
--    `gettxoutproof` to resolve.
-- ---------------------------------------------------------------------------
UPDATE public.anchors a
SET status              = 'SECURED',
    chain_tx_id         = r.chain_tx_id,
    chain_block_height  = r.block_height,
    chain_timestamp     = NOW(),
    chain_confirmations = 100,
    legal_hold          = true,
    updated_at          = NOW()
FROM pr2524_rows r
WHERE a.id = r.anchor_id
  AND (a.status IS DISTINCT FROM 'SECURED' OR a.chain_tx_id IS DISTINCT FROM r.chain_tx_id);

-- ---------------------------------------------------------------------------
-- POST-CONDITIONS — ENFORCED, NOT DOCUMENTED.
--
-- Every one of these is a property the driver's assertions silently assume. A
-- fixture that violates one does not fail loudly at seed time and instead
-- produces a soak whose evidence is quietly meaningless, which is the failure
-- mode this whole exercise exists to prevent. Any RAISE rolls the seed back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_wedge          integer;
  n_bulk           integer;
  n_spread         integer;
  n_candidates     integer;
  n_wedge_distinct integer;
  n_wedge_agrees   integer;
  min_bulk_id      uuid;
  max_wedge_id     uuid;
  n_bad_optree     integer;
  n_shared_block   integer;
  flag_enabled     boolean;
BEGIN
  SELECT count(*) INTO n_wedge  FROM public.anchors WHERE metadata->>'_purpose' = 'pr2524-proof-txinclusion' AND metadata->>'_cohort' = 'wedge'  AND status = 'SECURED';
  SELECT count(*) INTO n_bulk   FROM public.anchors WHERE metadata->>'_purpose' = 'pr2524-proof-txinclusion' AND metadata->>'_cohort' = 'bulk'   AND status = 'SECURED';
  SELECT count(*) INTO n_spread FROM public.anchors WHERE metadata->>'_purpose' = 'pr2524-proof-txinclusion' AND metadata->>'_cohort' = 'spread' AND status = 'SECURED';

  IF n_wedge <> 120 OR n_bulk <> 450 OR n_spread <> 2430 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: cohort sizes are wedge=% bulk=% spread=% (expected 120/450/2430)',
      n_wedge, n_bulk, n_spread;
  END IF;

  -- The bulk cohort must exceed the 200-value chunkForInFilter cap, or the
  -- batched-write assertion (A4) has nothing to cross.
  IF n_bulk <= 200 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: bulk cohort is % rows — it must exceed the 200-value .in() chunk cap for A4 to mean anything',
      n_bulk;
  END IF;

  -- Every fixture row must be a live candidate for the scan predicate
  -- (merkle_root NOT NULL and at least one bitcoin-tree column NULL).
  SELECT count(*) INTO n_candidates
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_purpose' = 'pr2524-proof-txinclusion'
     AND a.status = 'SECURED'
     AND a.chain_tx_id IS NOT NULL
     AND p.merkle_root IS NOT NULL
     AND (p.block_header IS NULL OR p.tx_inclusion_branch IS NULL OR p.tx_block_index IS NULL);
  IF n_candidates <> 3000 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: % of 3000 fixture rows match the populate scan predicate — the sweep would not see the rest',
      n_candidates;
  END IF;

  -- The wedge must DISAGREE with itself, or unanimousBlockHash() arms the
  -- group-level short-circuit, the run returns `stale`, the per-anchor gate
  -- never fires, and anchorsBlockMismatch stays 0 — leaving A2/A3 blind.
  SELECT count(DISTINCT p.block_hash) INTO n_wedge_distinct
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_purpose' = 'pr2524-proof-txinclusion'
     AND a.metadata->>'_cohort' = 'wedge';
  IF n_wedge_distinct < 2 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: wedge rows carry % distinct block_hash values — they must disagree so the per-anchor reorg gate (not the group short-circuit) decides',
      n_wedge_distinct;
  END IF;

  -- ...and none of them may name the block their tx is actually in, or the row
  -- would complete and stop being a wedge.
  SELECT count(*) INTO n_wedge_agrees
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
    JOIN pr2524_rows r ON r.anchor_id = a.id
   WHERE a.metadata->>'_cohort' = 'wedge'
     AND lower(p.block_hash) = lower(r.block_hash);
  IF n_wedge_agrees > 0 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: % wedge row(s) record the block their tx IS in — those rows would complete and stop wedging the sweep',
      n_wedge_agrees;
  END IF;

  -- Wedge must sort BEFORE bulk, or it is not at the head of the keyspace and
  -- the sweep's first page will not contain it.
  -- ORDER BY / LIMIT, not max()/min(): Postgres has no aggregate over `uuid`,
  -- and casting to text would silently compare a DIFFERENT ordering from the
  -- one the scan's `ORDER BY anchor_id` actually walks.
  SELECT a.id INTO max_wedge_id
    FROM public.anchors a
   WHERE a.metadata->>'_purpose' = 'pr2524-proof-txinclusion'
     AND a.metadata->>'_cohort' = 'wedge'
   ORDER BY a.id DESC
   LIMIT 1;
  SELECT a.id INTO min_bulk_id
    FROM public.anchors a
   WHERE a.metadata->>'_purpose' = 'pr2524-proof-txinclusion'
     AND a.metadata->>'_cohort' <> 'wedge'
   ORDER BY a.id ASC
   LIMIT 1;
  IF max_wedge_id >= min_bulk_id THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: wedge ids do not sort before the completable cohorts (% >= %) — the first sweep page would not include the wedge',
      max_wedge_id, min_bulk_id;
  END IF;

  -- The app-tree half must genuinely verify, or /proof publishes no bundle and
  -- A7/A8 can never pass. Single-leaf tree => root must equal the leaf.
  SELECT count(*) INTO n_bad_optree
    FROM public.anchor_proofs p
    JOIN public.anchors a ON a.id = p.anchor_id
   WHERE a.metadata->>'_purpose' = 'pr2524-proof-txinclusion'
     AND (
          p.merkle_root IS DISTINCT FROM a.fingerprint
       OR p.proof_path IS DISTINCT FROM '[]'::jsonb
       OR p.merkle_index IS DISTINCT FROM 0
       OR encode(p.op_return_payload, 'hex') IS DISTINCT FROM ('41524b56' || a.fingerprint)
     );
  IF n_bad_optree > 0 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: % row(s) have an app-tree/OP_RETURN shape that buildProofBundle would reject — no bundle means no read/write coherence evidence',
      n_bad_optree;
  END IF;

  -- The driver reads `/api/v1/proof/:public_id` for A7/A8/A9. `get_flag` fails
  -- CLOSED on an absent row, so without an ENABLED flag every one of those
  -- requests 503s before reaching application code while the worker still looks
  -- healthy — the 2026-08-20 wave2 failure. The BASELINE seed owns this row;
  -- this file only refuses to certify a fixture whose /api/v1 is dark.
  SELECT f.enabled INTO flag_enabled
    FROM public.switchboard_flags f
   WHERE f.flag_key = 'ENABLE_VERIFICATION_API';
  IF flag_enabled IS NOT TRUE THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: ENABLE_VERIFICATION_API is % — /api/v1 would be dark on this rig, so A7/A8/A9 could never pass. Run scripts/staging/seed-baseline-fixture.sql first (it owns this row).',
      COALESCE(flag_enabled::text, 'absent');
  END IF;

  -- A6 needs at least TWO DISTINCT txids sharing ONE block, for the multi-match
  -- gettxoutproof negative control.
  SELECT count(*) INTO n_shared_block
    FROM (
      SELECT r.block_hash
        FROM pr2524_rows r
       WHERE r.cohort <> 'wedge'
       GROUP BY r.block_hash
      HAVING count(DISTINCT r.chain_tx_id) >= 2
    ) s;
  IF n_shared_block = 0 THEN
    RAISE EXCEPTION
      'seed-proof-txinclusion-fixture: no block carries two distinct fixture txids — the B0 multi-match negative control (A6) cannot run';
  END IF;

  RAISE NOTICE
    'seed-proof-txinclusion-fixture: 3000 SECURED fixture anchors (wedge % / bulk % / spread %), all candidates, wedge non-unanimous and ahead of the keyspace, app-tree verifiable, multi-match block available',
    n_wedge, n_bulk, n_spread;
END;
$$;

COMMIT;
