/**
 * B2 — `GET /api/v1/verify/:publicId/proof` over the REAL database path.
 *
 * Every other suite for this route injects `_testLookup`, which short-circuits
 * past the `anchor_proofs` read entirely. That is exactly where the defect
 * lived: the select's `error` was destructured away, so a failing read became
 * `proofData = null` — indistinguishable from "this record has no proof row" —
 * and the route answered 404 `NO_BATCH_PROOF` with `proof_availability:
 * root_only`. No 5xx, nothing in Sentry, and a §1.5 "measured" claim the route
 * never measured.
 *
 * The realistic trigger is DEPLOY ORDERING, not a freak fault: this worker
 * revision selects `tx_inclusion_branch` / `tx_block_index`, and deploy and
 * migration-apply are separate steps. Between them (or before PostgREST
 * reloads its schema cache) every anchored document 404s. Same family as the
 * hollow-200 swallowed `statement_timeout`.
 *
 * These tests drive the router with NO `_testLookup` so the db branch runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../utils/db.js';
import { verifyProofRouter } from './verify-proof.js';
import { buildMerkleTree } from '../../utils/merkle.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');
const LEAVES = [fp('db-a'), fp('db-b'), fp('db-c'), fp('db-d')];
const TREE = buildMerkleTree(LEAVES);
const DOC_FP = LEAVES[0];

const GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

const ANCHOR_ROW = {
  id: 'anchor-uuid-1',
  public_id: 'PUB-DB-1',
  fingerprint: DOC_FP,
  status: 'SECURED',
  chain_tx_id: 'ab'.repeat(32),
  chain_block_height: 800_123,
  chain_timestamp: '2026-08-01T00:00:00.000Z',
  metadata: null,
};

const PROOF_ROW = {
  merkle_root: TREE.root,
  proof_path: TREE.proofs.get(DOC_FP),
  batch_id: 'batch-db-1',
  merkle_index: 0,
  block_header: `\\x${GENESIS_HEADER}`,
  block_hash: GENESIS_HASH,
  op_return_payload: `\\x41524b56${TREE.root}`,
  proof_schema_version: 1,
  tx_inclusion_branch: null,
  tx_block_index: null,
};

/**
 * Minimal PostgREST-shaped double covering the three reads the route makes:
 * the anchors lookup, the anchor_proofs row read, and the batch leaf count.
 */
function wireDb(opts: {
  anchor?: { data: unknown; error: unknown };
  proof?: { data: unknown; error: unknown };
  count?: { count: number | null; error: unknown };
}) {
  const anchor = opts.anchor ?? { data: ANCHOR_ROW, error: null };
  const proof = opts.proof ?? { data: PROOF_ROW, error: null };
  const count = opts.count ?? { count: LEAVES.length, error: null };

  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table === 'anchors') {
      return {
        select: () => ({
          eq: () => ({ is: () => ({ single: () => Promise.resolve(anchor) }) }),
        }),
      };
    }
    // anchor_proofs is read twice: `.eq().maybeSingle()` for the row and
    // `.eq()` (awaited directly) for the head count.
    return {
      select: (_cols: string, options?: { count?: string; head?: boolean }) => ({
        eq: () =>
          options?.head
            ? Promise.resolve(count)
            : { maybeSingle: () => Promise.resolve(proof) },
      }),
    };
  }) as unknown as typeof db.from);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/verify', verifyProofRouter);
  return app;
}

describe('B2 — /proof over the db path: a failing anchor_proofs read must NOT become a 404', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves a complete bundle on the happy path (the harness reaches the db branch)', async () => {
    wireDb({});
    const res = await request(buildApp()).get('/api/v1/verify/PUB-DB-1/proof');

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.proof_bundle).not.toBeNull();
  });

  // The deploy-ordering case, verbatim: PostgREST rejects the select because
  // migration 0427 has not been applied (or its schema cache is stale).
  it('returns 500 — not 404 — when the anchor_proofs select fails with 42703 (column does not exist)', async () => {
    wireDb({
      proof: {
        data: null,
        error: {
          code: '42703',
          message: 'column anchor_proofs.tx_inclusion_branch does not exist',
        },
      },
    });

    const res = await request(buildApp()).get('/api/v1/verify/PUB-DB-1/proof');

    expect(res.status).toBe(500);
    // …and it must NOT wear the honest-back-catalogue clothing of a 404.
    expect(res.body.proof_error_code).not.toBe('NO_BATCH_PROOF');
    expect(res.body.proof_availability).toBeUndefined();
    expect(res.body.proof_availability_note).toBeUndefined();
  });

  it('returns 500 on any other anchor_proofs read failure (e.g. statement timeout)', async () => {
    wireDb({
      proof: {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
    });

    const res = await request(buildApp()).get('/api/v1/verify/PUB-DB-1/proof');
    expect(res.status).toBe(500);
    expect(res.body.proof_availability).toBeUndefined();
  });

  // The honest 404 must survive: a record with genuinely NO proof row and no
  // legacy metadata branch is still root_only, and that IS a measurement.
  it('still returns the honest 404 root_only body when the read SUCCEEDS with no proof row', async () => {
    wireDb({ proof: { data: null, error: null } });

    const res = await request(buildApp()).get('/api/v1/verify/PUB-DB-1/proof');

    expect(res.status).toBe(404);
    expect(res.body.proof_error_code).toBe('NO_BATCH_PROOF');
    expect(res.body.proof_availability).toBe('root_only');
    expect(typeof res.body.proof_availability_note).toBe('string');
  });
});
