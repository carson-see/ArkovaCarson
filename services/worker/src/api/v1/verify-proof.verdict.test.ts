/**
 * R3 — tri-state `verdict` on `GET /api/v1/verify/:publicId/proof`.
 *
 * WHY A SEPARATE FILE. `verify-proof.test.ts` is 700+ lines and is concurrently
 * edited by `feat/proof-tx-inclusion-branch`. A new file keeps the merge
 * surface at zero and keeps this contract readable on its own.
 *
 * WHAT IS PINNED HERE
 *
 *  - K1 the invariant: `verified` and `verdict` are two encodings of ONE
 *    computation and can never contradict. Asserted on EVERY branch of the
 *    mapping, error paths included, by a table that the per-case tests below
 *    also drive — a new branch cannot be added without landing in it.
 *  - K2 additivity: every pre-existing key is byte-unchanged; `verdict` is
 *    purely additive (§1.8).
 *  - K4 honesty: a branch whose structural guard could not arm is
 *    `unverifiable`, NOT `valid` — proven with the repo's own forged
 *    self-pair fixture, which reads `verified: true` today.
 */

import { describe, expect, it } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import {
  verifyProofRouter,
  buildProofResponse,
  type ProofLookup,
  type ProofAnchorData,
  type ProofRecordData,
} from './verify-proof.js';
import { PROOF_VERDICT, PROOF_VERDICT_NOTE } from '../../constants/proofVerdict.js';
import { buildMerkleTree } from '../../utils/merkle.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

// A real 4-leaf batch tree so the recompute-and-compare verdict is genuine.
const LEAVES = [fp('doc-a'), fp('doc-b'), fp('doc-c'), fp('doc-d')];
const TREE = buildMerkleTree(LEAVES);
const DOC_FP = LEAVES[0];
const DOC_INDEX = 0;
const DOC_BRANCH = TREE.proofs.get(DOC_FP)!;

const ANCHOR: ProofAnchorData = {
  public_id: 'abc123',
  fingerprint: DOC_FP,
  status: 'SECURED',
  chain_tx_id: 'tx-999',
  chain_block_height: 800_000,
  chain_timestamp: '2026-04-18T10:00:00Z',
  metadata: {
    merkle_root: TREE.root,
    merkle_proof: DOC_BRANCH,
    merkle_index: DOC_INDEX,
    batch_id: 'batch-1',
  },
};

// ---------------------------------------------------------------------------
// The repo's own CVE-2012-2459 forged self-pair fixture (mirrors the construction
// in verify-proof.test.ts). A 3-leaf tree [a,b,c] where c legitimately self-pairs
// at level-0. The forgery claims index 0 of a size-4 level, which is NOT a
// rightmost-odd position. Recompute-and-compare ALONE accepts it; only the
// count-armed structural guard rejects it.
// ---------------------------------------------------------------------------
const sha = (d: Buffer) => createHash('sha256').update(d).digest();
const dsha = (d: Buffer) => sha(sha(d));
const cat = (x: string, y: string) => Buffer.concat([Buffer.from(x, 'hex'), Buffer.from(y, 'hex')]);
const A = fp('cve-a');
const B = fp('cve-b');
const C = fp('cve-c');
const AB = dsha(cat(A, B)).toString('hex');
const CC = dsha(cat(C, C)).toString('hex');
const CVE_ROOT = dsha(cat(AB, CC)).toString('hex');
const FORGED_BRANCH = [
  { hash: C, position: 'right' as const },
  { hash: AB, position: 'left' as const },
];
const FORGED_ANCHOR: ProofAnchorData = {
  ...ANCHOR,
  fingerprint: C,
  metadata: {
    merkle_root: CVE_ROOT,
    merkle_proof: FORGED_BRANCH,
    merkle_index: 0,
    batch_id: 'cve-batch',
  },
};

function metaAnchor(meta: Record<string, unknown>): ProofAnchorData {
  return { ...ANCHOR, metadata: { batch_id: 'b', ...meta } };
}

function buildApp(lookup: ProofLookup) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { _testLookup: ProofLookup })._testLookup = lookup;
    next();
  });
  app.use('/api/v1/verify', verifyProofRouter);
  return app;
}

// ---------------------------------------------------------------------------
// THE MAPPING TABLE. Every branch of the classification, with the justification
// for its class. Drives both the per-case tests and the K1 invariant sweep, so
// the two can never be checked against different populations.
// ---------------------------------------------------------------------------
interface Case {
  name: string;
  anchor: ProofAnchorData;
  stored?: ProofRecordData | null;
  leafCount?: number | null;
  indeterminate?: boolean;
  expected: string;
  /** true when the response is an error body (no `verified` field at all). */
  errorBody?: boolean;
}

const CASES: Case[] = [
  // ---- valid: every check we claim to run, ran and passed -----------------
  {
    name: 'honest branch, index + count known (structural guard ARMED and passed)',
    anchor: ANCHOR,
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.VALID,
  },
  {
    name: 'single-leaf tree: root == leaf, empty branch, index 0 of count 1',
    anchor: metaAnchor({
      merkle_root: buildMerkleTree([DOC_FP]).root,
      merkle_proof: [],
      merkle_index: 0,
    }),
    leafCount: 1,
    expected: PROOF_VERDICT.VALID,
  },
  {
    name: 'honest branch from a STORED anchor_proofs row with index + count',
    anchor: { ...ANCHOR, metadata: null },
    stored: {
      merkle_root: TREE.root,
      proof_path: DOC_BRANCH,
      batch_id: 'batch-1',
      merkle_index: DOC_INDEX,
    },
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.VALID,
  },

  // ---- invalid: a COMPLETED check genuinely failed (alarm) ----------------
  {
    name: 'recomputed root != committed root',
    anchor: metaAnchor({
      merkle_root: fp('unrelated-root'),
      merkle_proof: DOC_BRANCH,
      merkle_index: DOC_INDEX,
    }),
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.INVALID,
  },
  {
    name: 'wrong leaf (fingerprint is not in the tree)',
    anchor: { ...ANCHOR, fingerprint: fp('intruder') },
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.INVALID,
  },
  {
    name: 'flipped sibling positions',
    anchor: metaAnchor({
      merkle_root: TREE.root,
      merkle_proof: DOC_BRANCH.map((e) => ({
        ...e,
        position: (e.position === 'left' ? 'right' : 'left') as 'left' | 'right',
      })),
      merkle_index: DOC_INDEX,
    }),
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.INVALID,
  },
  {
    name: 'malformed sibling (well-shaped entry, not 64-hex)',
    anchor: metaAnchor({
      merkle_root: TREE.root,
      merkle_proof: [{ hash: 'not-a-hash', position: 'right' }],
      merkle_index: DOC_INDEX,
    }),
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.INVALID,
  },
  {
    name: 'malformed committed root (present but not 64-hex)',
    anchor: metaAnchor({
      merkle_root: 'deadbeef',
      merkle_proof: DOC_BRANCH,
      merkle_index: DOC_INDEX,
    }),
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.INVALID,
  },
  {
    name: 'empty branch but root != leaf (single-leaf tree that does not hold)',
    anchor: metaAnchor({ merkle_root: TREE.root, merkle_proof: [], merkle_index: 0 }),
    leafCount: 1,
    expected: PROOF_VERDICT.INVALID,
  },
  {
    name: 'leaf index outside the tree (internally contradictory row)',
    anchor: metaAnchor({
      merkle_root: TREE.root,
      merkle_proof: DOC_BRANCH,
      merkle_index: 99,
    }),
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.INVALID,
  },
  {
    name: 'CVE-2012-2459 forged self-pair, guard ARMED (count known) — rejected',
    anchor: FORGED_ANCHOR,
    leafCount: 4,
    expected: PROOF_VERDICT.INVALID,
  },

  // ---- unverifiable: a check we advertise could not be completed ----------
  {
    name: 'legacy row: no merkle_index, so the structural guard could not arm',
    anchor: metaAnchor({ merkle_root: TREE.root, merkle_proof: DOC_BRANCH }),
    leafCount: LEAVES.length,
    expected: PROOF_VERDICT.UNVERIFIABLE,
  },
  {
    name: 'index known but leaf_count unresolved (not batch-linked)',
    anchor: ANCHOR,
    leafCount: null,
    expected: PROOF_VERDICT.UNVERIFIABLE,
  },
  {
    name: 'CVE-2012-2459 forged self-pair, guard NOT armed — never claimed valid',
    anchor: FORGED_ANCHOR,
    leafCount: null,
    expected: PROOF_VERDICT.UNVERIFIABLE,
  },
  {
    name: 'batch-linked proof whose exact leaf_count is indeterminate (fails closed)',
    anchor: ANCHOR,
    leafCount: null,
    indeterminate: true,
    expected: PROOF_VERDICT.UNVERIFIABLE,
    errorBody: true,
  },
];

function runCase(c: Case) {
  return buildProofResponse(
    c.anchor,
    c.stored ?? null,
    c.leafCount ?? null,
    c.indeterminate ?? false,
  );
}

describe('R3 — verdict mapping, case by case', () => {
  for (const c of CASES) {
    it(`${c.name} => ${c.expected}`, () => {
      const result = runCase(c);
      expect(result).not.toBeNull();
      const body = result as unknown as Record<string, unknown>;
      expect(body.verdict).toBe(c.expected);
      expect(body.verdict_note).toBe(
        PROOF_VERDICT_NOTE[c.expected as keyof typeof PROOF_VERDICT_NOTE],
      );
      // Error bodies carry no `verified` at all; success bodies always do.
      expect('error' in body).toBe(Boolean(c.errorBody));
    });
  }
});

describe('R3 K1 — verified and verdict can never contradict', () => {
  it('verdict === invalid  <=>  verified === false, on EVERY branch', () => {
    for (const c of CASES) {
      const body = runCase(c) as unknown as Record<string, unknown>;
      if (c.errorBody) continue; // no `verified` field to compare against
      const isInvalid = body.verdict === PROOF_VERDICT.INVALID;
      expect(isInvalid, `${c.name}: verdict/verified disagree`).toBe(body.verified === false);
    }
  });

  it('a non-invalid verdict always rides on verified === true', () => {
    // `valid` and `unverifiable` both partition the OLD `verified: true`
    // bucket. Neither may ever appear next to `verified: false` — that would
    // be the exact contradiction K1 forbids.
    for (const c of CASES) {
      if (c.errorBody) continue;
      const body = runCase(c) as unknown as Record<string, unknown>;
      if (body.verdict !== PROOF_VERDICT.INVALID) {
        expect(body.verified, `${c.name}`).toBe(true);
      }
    }
  });

  it('the two are derived from ONE computation — no branch produces only one of them', () => {
    for (const c of CASES) {
      const body = runCase(c) as unknown as Record<string, unknown>;
      expect(body.verdict, `${c.name}: verdict missing`).toBeDefined();
      if (!c.errorBody) {
        expect(typeof body.verified, `${c.name}: verified missing`).toBe('boolean');
      }
    }
  });

  it('the table covers all three verdicts (no dead class, no untested class)', () => {
    const seen = new Set(CASES.map((c) => c.expected));
    expect([...seen].sort()).toEqual(['invalid', 'unverifiable', 'valid']);
  });
});

describe('R3 K4 — honesty: a guard that did not arm is never reported as valid', () => {
  it('the SAME forged branch is unverifiable without a count and invalid with one', () => {
    // This is the whole argument for the legacy-row judgement call. The branch
    // is structurally forged. Today it reads `verified: true` when the count is
    // unknown (verify-proof.test.ts pins that as documented residual risk).
    // Calling that `valid` would launder a known-forgeable state into a clean
    // bill of health; `unverifiable` states what actually happened.
    const without = runCase({ ...CASES[0], name: '', anchor: FORGED_ANCHOR, leafCount: null, expected: '' }) as unknown as Record<string, unknown>;
    const with_ = runCase({ ...CASES[0], name: '', anchor: FORGED_ANCHOR, leafCount: 4, expected: '' }) as unknown as Record<string, unknown>;

    expect(without.verified).toBe(true);
    expect(without.verdict).toBe(PROOF_VERDICT.UNVERIFIABLE);

    expect(with_.verified).toBe(false);
    expect(with_.verdict).toBe(PROOF_VERDICT.INVALID);
  });

  it('the guard-armed predicate agrees with the verifier that consumed it', () => {
    // Behavioural pin, not a textual one: `valid` is emitted exactly when the
    // structural guard was live, which is observable as "the forged branch gets
    // rejected". If the arming predicate here ever drifts from the one inside
    // the (byte-identity-pinned) verifier, one of these two flips and this test
    // goes red.
    const armed = runCase({ ...CASES[0], name: '', anchor: FORGED_ANCHOR, leafCount: 4, expected: '' }) as unknown as Record<string, unknown>;
    const honestArmed = runCase({ ...CASES[0], name: '', anchor: ANCHOR, leafCount: LEAVES.length, expected: '' }) as unknown as Record<string, unknown>;

    // Guard live => forgery rejected AND honest proof still valid.
    expect(armed.verdict).toBe(PROOF_VERDICT.INVALID);
    expect(honestArmed.verdict).toBe(PROOF_VERDICT.VALID);
  });

  it('leafCount 0 does not arm the guard (>= 1 required, matching the verifier)', () => {
    // A count of 0 passes a naive `!= null` check but NOT the verifier's
    // `>= 1`. Deriving the flag from a different predicate than the verifier
    // uses is exactly how `valid` would be claimed with the guard inactive.
    const body = runCase({
      ...CASES[0],
      name: '',
      anchor: ANCHOR,
      leafCount: 0,
      expected: '',
    }) as unknown as Record<string, unknown>;
    expect(body.verdict).toBe(PROOF_VERDICT.UNVERIFIABLE);
  });
});

describe('R3 K2 — additive only, existing contract untouched (§1.8)', () => {
  const LEGACY_KEYS = [
    'public_id',
    'fingerprint',
    'merkle_root',
    'merkle_proof',
    'tx_id',
    'block_height',
    'block_timestamp',
    'batch_id',
    'verified',
    'proof_bundle',
  ];

  it('every pre-existing key is still present with its old value', () => {
    const body = runCase({
      ...CASES[0],
      name: '',
      anchor: ANCHOR,
      leafCount: LEAVES.length,
      expected: '',
    }) as unknown as Record<string, unknown>;
    for (const k of LEGACY_KEYS) {
      expect(body, `missing legacy key ${k}`).toHaveProperty(k);
    }
    expect(body.public_id).toBe('abc123');
    expect(body.fingerprint).toBe(DOC_FP);
    expect(body.merkle_root).toBe(TREE.root);
    expect(body.verified).toBe(true);
  });

  it('the ONLY new top-level keys are verdict + verdict_note', () => {
    const body = runCase({
      ...CASES[0],
      name: '',
      anchor: ANCHOR,
      leafCount: LEAVES.length,
      expected: '',
    }) as unknown as Record<string, unknown>;
    const extra = Object.keys(body).filter((k) => !LEGACY_KEYS.includes(k));
    expect(extra.sort()).toEqual(['verdict', 'verdict_note']);
  });

  it('verdict is NEVER placed inside proof_bundle (the signable artifact)', () => {
    // Three separate suites pin the exact proof_bundle key set. The verdict is
    // API-layer interpretation, not cryptographic evidence, and putting it in
    // the bundle would both break those and change what gets signed.
    const anchorWithBundle: ProofAnchorData = { ...ANCHOR, metadata: null };
    const stored: ProofRecordData = {
      merkle_root: TREE.root,
      proof_path: DOC_BRANCH,
      batch_id: 'batch-1',
      merkle_index: DOC_INDEX,
      block_header: `\\x${'ab'.repeat(80)}`,
      block_hash: 'cd'.repeat(32),
      op_return_payload: `\\x41524b56${TREE.root}`,
      proof_schema_version: 1,
    };
    const body = buildProofResponse(anchorWithBundle, stored, LEAVES.length) as unknown as {
      proof_bundle: Record<string, unknown> | null;
    };
    expect(body.proof_bundle).not.toBeNull();
    expect(Object.keys(body.proof_bundle!)).not.toContain('verdict');
    expect(Object.keys(body.proof_bundle!)).not.toContain('verdict_note');
  });
});

describe('R3 — route-level emission', () => {
  const lookupFor = (anchor: ProofAnchorData | null): ProofLookup => ({
    lookupByPublicId: async () => anchor,
  });

  it('200 body carries verdict + verdict_note alongside the unchanged verified', async () => {
    const res = await request(buildApp(lookupFor(ANCHOR))).get('/api/v1/verify/abc123/proof');
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    // The injected-lookup path supplies no leaf_count, so the guard cannot arm.
    expect(res.body.verdict).toBe(PROOF_VERDICT.UNVERIFIABLE);
    expect(res.body.verdict_note).toBe(PROOF_VERDICT_NOTE[PROOF_VERDICT.UNVERIFIABLE]);
  });

  it('the NO_BATCH_PROOF 404 carries NO verdict (nothing was verified)', async () => {
    const bare: ProofAnchorData = { ...ANCHOR, metadata: null };
    const res = await request(buildApp(lookupFor(bare))).get('/api/v1/verify/abc123/proof');
    expect(res.status).toBe(404);
    expect(res.body.proof_error_code).toBe('NO_BATCH_PROOF');
    expect(res.body).not.toHaveProperty('verdict');
  });

  it('the RECORD_NOT_FOUND 404 carries NO verdict', async () => {
    const res = await request(buildApp(lookupFor(null))).get('/api/v1/verify/nope/proof');
    expect(res.status).toBe(404);
    expect(res.body.proof_error_code).toBe('RECORD_NOT_FOUND');
    expect(res.body).not.toHaveProperty('verdict');
  });

  it('the 400 carries NO verdict', async () => {
    const res = await request(buildApp(lookupFor(ANCHOR))).get('/api/v1/verify/ab/proof');
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty('verdict');
  });

  it('a malformed stored branch 500s WITHOUT an alarm verdict', async () => {
    // Extraction failed before any verification was attempted. Emitting
    // `invalid` here would raise a cryptographic alarm from a parse error —
    // the exact cry-wolf failure this change exists to prevent.
    const badMeta: ProofAnchorData = {
      ...ANCHOR,
      metadata: { merkle_root: TREE.root, merkle_proof: [{ nope: true }], batch_id: 'b' },
    };
    const res = await request(buildApp(lookupFor(badMeta))).get('/api/v1/verify/abc123/proof');
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('verdict');
  });
});
