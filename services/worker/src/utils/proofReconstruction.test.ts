/**
 * Tests for the chain-verified proof reconstruction engine (SCRUM-3187).
 *
 * The single invariant under test everywhere below: a proof is NEVER emitted
 * unless it verifies against the root actually committed on-chain. A proof
 * that does not verify is a false integrity claim, so the engine must prefer
 * returning NOTHING over returning something plausible.
 */

import { describe, expect, it } from 'vitest';

import { buildMerkleTree, verifyMerkleProof } from './merkle.js';
import {
  MAX_PERMUTATION_SEARCH_LEAVES,
  parseCommittedRoot,
  reconstructBatch,
  type ReconstructionLeaf,
} from './proofReconstruction.js';

/** Build a leaf whose id/created_at deliberately disagree with fingerprint order. */
function leaf(id: string, fingerprint: string, createdAt = '2026-03-27T00:00:00.000Z'): ReconstructionLeaf {
  return { id, fingerprint, createdAt };
}

const FP = (n: number): string => n.toString(16).padStart(64, '0');

// ── Real production golden vectors ───────────────────────────────────────────
// Roots below are the ACTUAL on-chain OP_RETURN commitments for these txs,
// read from mempool.space; leaf sets are the actual prod `anchors` rows.

const GOLDEN_MARCH_3 = {
  tx: 'be6c8a2ba94ff797dc312d5250dbf7f07c03b2bbff500c639c14d1edef3ee69f',
  root: 'e5946ecddc6fda9f3188533d5c758495803310c326debd5c7a37d671cbdbed2a',
  leaves: [
    leaf('7bf17220-3e3a-4e47-a08e-88f195a74590', 'c0bdd53d17120d84b37ad803853b492faca9c60f1d8f99d478c8dcbea95994b6', '2026-03-27T11:00:02.904789Z'),
    leaf('8d265ee1-e940-447b-a969-3d055afa1e88', 'fcf8eb693ec8c88d3ffe626edc53c8ae8f7d0e4e4a3f2f18e4d6de7f6b034ac9', '2026-03-27T11:00:03.006325Z'),
    leaf('f319c086-53ff-4411-a455-9e3464c97ada', '8c3baea6b45fa96d7adf32e108f172c5eea373e9ce73c47e3f5268dcfdd7ca4a', '2026-03-27T11:00:02.843571Z'),
  ],
};

const GOLDEN_MARCH_6 = {
  tx: '606b7eec2a008032d2c1e7069e2cbcdfbb7b97723d40e31d4f26a8ff9803bfcd',
  root: '0ea8832ec340254fbf2d9bba7bbb688b1e55a35741e715bc701d2d8756b8db1b',
  leaves: [
    leaf('097ad967-aa1e-4b10-a523-9d53fa3da10b', 'fd591188d2d4766f8a1e1de27f75e7c17edeea3b7b6986eb87f780e3a1b79407', '2026-03-27T07:10:03.063243Z'),
    leaf('d314538e-0f4d-416c-ba92-574dc3b6232e', 'df69be6c4d4f4f4f233995f183d854ecfcf45316959519eac86aa03457556f40', '2026-03-27T07:10:02.971295Z'),
    leaf('c0f3cc49-9366-41b8-810c-e9dd4d627f6c', '4bc35e5a4d03b85da579552de94be45625abb04b1976bd5430f52541792688b7', '2026-03-27T07:10:02.880747Z'),
    leaf('ffc2a8a7-fa19-42e2-930f-621a81d15dac', '66fb96726758a5a23060240eff37dcfe7e44e7dabadb0f5b4e2e734530ac3c63', '2026-03-27T07:10:02.792934Z'),
    leaf('3c071324-1461-4007-8a61-3c556ed9723e', '6fa5f9310729a281913aef055ceec7d74cdd76b0689bb729d0f245bcf53bea91', '2026-03-27T07:10:02.700409Z'),
    leaf('90536462-5b3c-440e-8f17-099a54b6cb45', 'd45182ced5c95e9fcb4b86efa5d72195715c8a8c119c64c21d970bfa4d09cb9d', '2026-03-27T07:10:02.601596Z'),
  ],
};

/** 2026-08 batch: reconstructs under a DETERMINISTIC ordering (id asc), no search. */
const GOLDEN_AUG_14 = {
  tx: 'd2b0407e1021f936b8259e708e62a1ea205bb57d60d0292baf3b1e5f2264f19f',
  root: '77422a1d51efa49936bb8584ca403896c5ba7c40de502aeb1b7cef38b996a350',
  leaves: [
    leaf('1c0aa1aa-95f0-4b09-bb0a-23ed6e450988', 'a00439e5b93b3144164c80698b3e4611297fd835d53532cc57608b25804e35a9'),
    leaf('1ec66129-6d6b-48ff-8ba5-1b97e4aa51d7', '8b3d585bf40f600a9731b3ac79629f71f8d5506380d1326dbea42a4bc7d0c5ad'),
    leaf('3e61cb40-4ec2-48ee-82f5-f7b80081c64c', 'cb1ca2be38d568c591ef4d4f259833e3b705e4a5b5704cc944c55232e449751e'),
    leaf('4391de37-a484-42c5-8a44-30088d2bb879', '137e56843e2a84fa332b5d1349590840f528145fbe066d81cc85ff63b5fe70ab'),
    leaf('6119c484-9d1b-4cdc-8d72-338d722de4a9', 'a0798cae4c0e17bc87013540274542f3e661a77ce76fda89fabaf3485f1a8ad3'),
    leaf('61e517b2-e108-4f35-b577-c093c995c642', '72cbb16b67b579426c8cb4db702428f6da5dd0bfe7debafadbd903b994e8c474'),
    leaf('7a2d8f20-c3f3-494b-b77f-a124803de9db', '95acea712c708902bdc983ab4920de4b682917fd32e26f0b95d38b278434954f'),
    leaf('890ff323-bf8c-454c-9d70-29254fbcd0e9', 'c5074d0e76b4910865f131e58500fa9b97166d2e35a15ebb6d9a626b5807f15e'),
    leaf('c2a1deef-4610-4ac8-be53-9225a98c3cae', 'd121d379451cdc47032a23486c3eae779078ddebd5e9e6d5a38a058b5cc430f6'),
    leaf('c2e36810-41e8-4ffb-a662-f144d543c4ce', '1d5d13e07e701cf71a78a65b5a6197a4788361bcb1b737ea0e8cc23ea9787a90'),
    leaf('c5d60cc9-8159-456e-9fbe-3a38ccc9383e', 'e13bdc0257c7e44c06e6ec4a3afef9fc65a03654d8cbe7ac8ed85972cc3339bf'),
    leaf('d5f6ae79-bb6a-4366-9868-ddbe68cdbf12', '98453b3ec0672ecb5eec37adc6ac42ad1912d8c1cef982948c14892535b6f09c'),
    leaf('f1dd8f26-dc4d-488d-838b-33d5b7b4d470', '2b46ad6a511d9f20f41a1eda55f9c789125148682bc4789b2a3844eadfbbcde2'),
    leaf('f2b3eda3-9fa7-4bcf-a3c2-d1c28f467c3b', 'e5ce71b586bab8db940fd2b72f1870eb06fa1a06829a76baae0b3ffd7148f49f'),
  ],
};

describe('parseCommittedRoot', () => {
  it('extracts the 32-byte root from an ARKV OP_RETURN payload', () => {
    const root = 'a'.repeat(64);
    expect(parseCommittedRoot(`41524b56${root}`)).toBe(root);
  });

  it('tolerates the OP_RETURN script prefix and 0x/case variants', () => {
    const root = 'b'.repeat(64);
    expect(parseCommittedRoot(`6a2441524B56${root.toUpperCase()}`)).toBe(root);
    expect(parseCommittedRoot(`0x41524b56${root}`)).toBe(root);
  });

  it('accepts the optional 8-byte metadata suffix', () => {
    const root = 'c'.repeat(64);
    expect(parseCommittedRoot(`41524b56${root}${'11'.repeat(8)}`)).toBe(root);
  });

  it('returns null for payloads that are not ARKV commitments', () => {
    expect(parseCommittedRoot('')).toBeNull();
    expect(parseCommittedRoot('deadbeef')).toBeNull();
    // right length, wrong marker — must NOT be read as a root
    expect(parseCommittedRoot(`deadbeef${'a'.repeat(64)}`)).toBeNull();
    // ARKV marker but truncated root
    expect(parseCommittedRoot(`41524b56${'a'.repeat(62)}`)).toBeNull();
    expect(parseCommittedRoot('not-hex-at-all')).toBeNull();
  });
});

describe('reconstructBatch — the never-fabricate invariant', () => {
  it('refuses an empty leaf set', () => {
    const out = reconstructBatch([], FP(1));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('empty_leaf_set');
  });

  it('refuses when no committed root is available', () => {
    const out = reconstructBatch([leaf('a', FP(1))], null);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no_committed_root');
  });

  it('refuses a malformed committed root rather than coercing it', () => {
    const out = reconstructBatch([leaf('a', FP(1))], 'not-a-root');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('malformed_committed_root');
  });

  it('emits NOTHING when the committed root does not match any ordering', () => {
    const leaves = [leaf('a', FP(1)), leaf('b', FP(2)), leaf('c', FP(3))];
    const out = reconstructBatch(leaves, FP(999));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('leaf_order_unrecoverable');
  });

  it('does not silently succeed when one leaf is MISSING from the set', () => {
    const full = [leaf('a', FP(1)), leaf('b', FP(2)), leaf('c', FP(3)), leaf('d', FP(4))];
    const committed = buildMerkleTree(full.map((l) => l.fingerprint)).root;
    const truncated = full.slice(0, 3);
    const out = reconstructBatch(truncated, committed);
    expect(out.ok).toBe(false);
  });

  it('does not silently succeed when a leaf fingerprint is ALTERED', () => {
    const full = [leaf('a', FP(1)), leaf('b', FP(2)), leaf('c', FP(3))];
    const committed = buildMerkleTree(full.map((l) => l.fingerprint)).root;
    const tampered = [leaf('a', FP(1)), leaf('b', FP(77)), leaf('c', FP(3))];
    const out = reconstructBatch(tampered, committed);
    expect(out.ok).toBe(false);
  });
});

describe('reconstructBatch — single-leaf (degenerate) batches', () => {
  it('emits an empty branch when the committed root IS the fingerprint', () => {
    const fp = FP(42);
    const out = reconstructBatch([leaf('solo', fp)], fp);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ anchor_id: 'solo', merkle_root: fp, merkle_index: 0 });
    expect(out.rows[0].proof_path).toEqual([]);
    expect(out.leafCount).toBe(1);
  });

  it('REFUSES a single leaf whose fingerprint is not the committed root', () => {
    // The degenerate case is exactly where fabrication is easiest — a batch of
    // one must still be checked against the chain, never assumed.
    const out = reconstructBatch([leaf('solo', FP(42))], FP(43));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('leaf_order_unrecoverable');
  });
});

describe('reconstructBatch — real production batches', () => {
  it.each([
    ['march n=3 (order recovered by search)', GOLDEN_MARCH_3],
    ['march n=6 (order recovered by search)', GOLDEN_MARCH_6],
    ['aug n=14 (order recovered deterministically)', GOLDEN_AUG_14],
  ])('reconstructs %s against its real on-chain root', (_name, golden) => {
    const out = reconstructBatch(golden.leaves, golden.root);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.rows).toHaveLength(golden.leaves.length);
    // Every emitted row must carry the CHAIN root, not a locally computed one.
    for (const row of out.rows) {
      expect(row.merkle_root).toBe(golden.root);
    }
    // Every anchor in the batch gets exactly one row, and indices are a
    // permutation of 0..n-1 (no duplicates, no gaps).
    expect(new Set(out.rows.map((r) => r.anchor_id)).size).toBe(golden.leaves.length);
    expect([...out.rows.map((r) => r.merkle_index)].sort((a, b) => a - b)).toEqual(
      golden.leaves.map((_l, i) => i),
    );
  });

  it('every emitted branch independently verifies against the on-chain root', () => {
    for (const golden of [GOLDEN_MARCH_3, GOLDEN_MARCH_6, GOLDEN_AUG_14]) {
      const out = reconstructBatch(golden.leaves, golden.root);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const byId = new Map(golden.leaves.map((l) => [l.id, l.fingerprint]));
      for (const row of out.rows) {
        const fingerprint = byId.get(row.anchor_id) as string;
        // This is the check an offline verifier performs.
        expect(verifyMerkleProof(fingerprint, row.proof_path, golden.root)).toBe(true);
      }
    }
  });

  it('rejects the march batch when given a neighbouring batch root', () => {
    const out = reconstructBatch(GOLDEN_MARCH_6.leaves, GOLDEN_MARCH_3.root);
    expect(out.ok).toBe(false);
  });
});

describe('reconstructBatch — legacy stored branches (untrusted input)', () => {
  it('accepts stored branches when every one verifies against the chain root', () => {
    const base = [leaf('a', FP(1)), leaf('b', FP(2)), leaf('c', FP(3)), leaf('d', FP(4))];
    const tree = buildMerkleTree(base.map((l) => l.fingerprint));
    const withBranches = base.map((l, i) => ({ ...l, storedBranch: tree.proofsByIndex[i] }));

    const out = reconstructBatch(withBranches, tree.root);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ordering).toBe('stored_branch');
    expect(out.rows.map((r) => r.merkle_index)).toEqual([0, 1, 2, 3]);
    for (const row of out.rows) {
      const fp = withBranches.find((l) => l.id === row.anchor_id)?.fingerprint as string;
      expect(verifyMerkleProof(fp, row.proof_path, tree.root)).toBe(true);
    }
  });

  it('rejects the WHOLE batch when a single stored branch does not verify', () => {
    const base = [leaf('a', FP(1)), leaf('b', FP(2)), leaf('c', FP(3)), leaf('d', FP(4))];
    const tree = buildMerkleTree(base.map((l) => l.fingerprint));
    const withBranches = base.map((l, i) => ({ ...l, storedBranch: tree.proofsByIndex[i] }));
    // Corrupt one sibling hash — a partially-true batch must not be served.
    withBranches[2] = {
      ...withBranches[2],
      storedBranch: [{ hash: FP(999), position: 'left' as const }],
    };

    const out = reconstructBatch(withBranches, tree.root);
    // Falls through to ordering recovery, which still produces only VERIFIED
    // rows — and never the corrupt branch.
    if (out.ok) {
      expect(out.ordering).not.toBe('stored_branch');
      for (const row of out.rows) {
        const fp = base.find((l) => l.id === row.anchor_id)?.fingerprint as string;
        expect(verifyMerkleProof(fp, row.proof_path, tree.root)).toBe(true);
      }
    }
  });

  it('rejects a real prod legacy branch that does not verify (batch 8f62259b)', () => {
    // Regression pin for the actual hazard found in prod: these branches are
    // stored on live anchors and are NOT valid inclusion proofs for the
    // committed root. Copying them into anchor_proofs would be a false claim.
    const chainRoot = '5cdfe18e36419854667147a2db6c9b5d8b04d1830555666ed2a9932f3c6edb0f';
    const fingerprint = '511c3eb8ef86f86e5cd4f4aa4ad7f3d0f902d152c934918a709ce2a0333a824d';
    const storedBranch = [
      { hash: 'b60c8788ef4cc67cd8cdd1d8adc53097a2acb1403fc6d1ace3ba98084929f086', position: 'right' as const },
      { hash: 'd1add83fb599d6d03db01cd4d1fd6a61d04d5742a82a2011ebe67145b9dc039a', position: 'right' as const },
      { hash: '3d119d27896d2e604a98af1a6a316d28d7874e3d67cd07e8d725385e137e4309', position: 'right' as const },
      { hash: '44a208f6d18e6b2e8ae447a3ca3c5964981611317d0213e5da11ed490d084323', position: 'left' as const },
      { hash: '13f863a90e6c71c876b4e37a4f4d4044224ac790d48daa29da3cdb75737f8fce', position: 'right' as const },
      { hash: 'c2af3a11e7c33890ce73ba558e6a9f3d61d509e96a8c51245276e463e5a08631', position: 'right' as const },
      { hash: '59ee1a5c779d313d2c3146b48f5bc51896cf8cf4053ffe7299ae2430bb98cb1f', position: 'right' as const },
      { hash: '73fb097c293fbf160d8448a012ed322c1c1d9f51142c3b000ca0adb2ce6911c3', position: 'right' as const },
      { hash: 'b2803983c9e5c889857ad3ea0d83170f6b6a713391bf6c01e80172f79074a140', position: 'left' as const },
      { hash: 'c3bd675c1530a9985567ec0fd1d65d3761e675660b29dbfb5f694eb8f32ccf5f', position: 'left' as const },
    ];
    expect(verifyMerkleProof(fingerprint, storedBranch, chainRoot)).toBe(false);

    const out = reconstructBatch(
      [{ id: 'ebd604bb', fingerprint, createdAt: '2026-03-26T18:11:04.289Z', storedBranch }],
      chainRoot,
    );
    expect(out.ok).toBe(false);
  });
});

describe('reconstructBatch — bounded search', () => {
  it('does not attempt permutation search beyond the leaf budget', () => {
    // Construct a batch larger than the budget whose order is NOT any of the
    // deterministic candidates, so only a search could find it.
    const n = MAX_PERMUTATION_SEARCH_LEAVES + 3;
    const leaves = Array.from({ length: n }, (_, i) => leaf(`id-${i}`, FP(i + 1)));
    const scrambled = [leaves[2], leaves[0], leaves[n - 1], ...leaves.slice(3, n - 1), leaves[1]];
    const committed = buildMerkleTree(scrambled.map((l) => l.fingerprint)).root;

    const started = Date.now();
    const out = reconstructBatch(leaves, committed);
    // It must give up quickly and honestly rather than hang.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('leaf_order_unrecoverable');
  });

  it('caps a caller-supplied search budget (factorial DoS switch)', () => {
    // An unclamped override would let a caller request 15! trees.
    const n = MAX_PERMUTATION_SEARCH_LEAVES + 4;
    const leaves = Array.from({ length: n }, (_, i) => leaf(`id-${i}`, FP(i + 1)));
    const scrambled = [leaves[1], leaves[0], ...leaves.slice(2).reverse()];
    const committed = buildMerkleTree(scrambled.map((l) => l.fingerprint)).root;

    const started = Date.now();
    const out = reconstructBatch(leaves, committed, { maxPermutationLeaves: 99 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.ok).toBe(false);
  });

  it('reports which named ordering succeeded so the result is auditable', () => {
    const leaves = [leaf('b-id', FP(2)), leaf('a-id', FP(1)), leaf('c-id', FP(3))];
    const idAsc = [...leaves].sort((x, y) => x.id.localeCompare(y.id));
    const committed = buildMerkleTree(idAsc.map((l) => l.fingerprint)).root;
    const out = reconstructBatch(leaves, committed);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.ordering).toBe('id_asc');
  });

  it('is deterministic: repeated runs give identical output', () => {
    const a = reconstructBatch(GOLDEN_MARCH_6.leaves, GOLDEN_MARCH_6.root);
    const b = reconstructBatch(GOLDEN_MARCH_6.leaves, GOLDEN_MARCH_6.root);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
