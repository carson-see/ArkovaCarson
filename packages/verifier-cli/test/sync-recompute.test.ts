/**
 * SHARED-RECOMPUTE GUARD.
 *
 * The verifier must reuse the SAME canonical Merkle recompute routine the
 * server uses — never a divergent re-implementation (PROOF-07 hard AC). We
 * ship the recompute as a VERBATIM copy of the worker source under
 * `src/vendor/`, and this test fails the build the moment the vendored copy
 * drifts byte-for-byte from `services/worker/src/utils/`.
 *
 * Two guards:
 *   1. byte-identity of the vendored files vs the worker source;
 *   2. behavioral parity — the vendored `verifyMerkleInclusion` and the worker's
 *      own export return identical verdicts across every fixture (proven by
 *      importing the actual worker module).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyMerkleInclusion as vendoredVerify } from '../src/vendor/merkle-verify.js';
// Import the ACTUAL worker recompute — proves we run the same code, not a copy.
import { verifyMerkleInclusion as workerVerify } from '../../../services/worker/src/utils/merkle-verify.js';
import { loadSyntheticFixtures } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, '..');
const WORKER_UTILS = join(PKG, '..', '..', 'services', 'worker', 'src', 'utils');

const VENDORED = [
  ['merkle-verify.ts', 'src/vendor/merkle-verify.ts'],
  ['merkle.ts', 'src/vendor/merkle.ts'],
  ['canonical-json.ts', 'src/vendor/canonical-json.ts'],
] as const;

describe('shared recompute — byte-identity guard', () => {
  for (const [workerName, vendoredRel] of VENDORED) {
    it(`vendor/${workerName} is byte-identical to the worker source`, () => {
      const workerSrc = readFileSync(join(WORKER_UTILS, workerName), 'utf8');
      const vendoredSrc = readFileSync(join(PKG, vendoredRel), 'utf8');
      expect(
        vendoredSrc,
        `vendor/${workerName} drifted from services/worker/src/utils/${workerName}. ` +
          'Re-copy it (npm run sync) — the recompute MUST stay shared, never re-implemented.',
      ).toBe(workerSrc);
    });
  }
});

describe('shared recompute — behavioral parity with the worker', () => {
  const fixtures = loadSyntheticFixtures();
  for (const f of fixtures) {
    it(`${f.name}: vendored verdict == worker verdict`, () => {
      const opts =
        typeof f.packet.merkle_index === 'number'
          ? { leafIndex: f.packet.merkle_index, leafCount: f.packet.leaf_count ?? undefined }
          : {};
      const a = vendoredVerify(f.packet.fingerprint, f.packet.merkle_proof, f.packet.merkle_root, opts);
      const b = workerVerify(f.packet.fingerprint, f.packet.merkle_proof, f.packet.merkle_root, opts);
      expect(a).toEqual(b);
    });
  }
});
