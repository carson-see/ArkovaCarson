/**
 * VAI-02: ZK Proof Module — Tests
 *
 * TDD tests for zero-knowledge proof generation and verification.
 * Uses Poseidon hash + PLONK proof system via snarkjs.
 */

import { describe, it, expect } from 'vitest';
import {
  computePoseidonHash,
  splitHashToFieldElements,
  computeManifestCommitment,
  generateZkProof,
  verifyZkProof,
  CIRCUIT_VERSION,
} from './zk-proof.js';

describe('zk-proof', () => {
  describe('computePoseidonHash', () => {
    it('returns a hex string for valid input chunks', () => {
      const chunks = [1n, 2n, 3n, 4n];
      const hash = computePoseidonHash(chunks);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      // Poseidon output is a field element, hex-encoded
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('produces deterministic output for same input', () => {
      const chunks = [100n, 200n, 300n, 400n];
      const hash1 = computePoseidonHash(chunks);
      const hash2 = computePoseidonHash(chunks);

      expect(hash1).toBe(hash2);
    });

    it('produces different output for different input', () => {
      const hash1 = computePoseidonHash([1n, 2n, 3n, 4n]);
      const hash2 = computePoseidonHash([5n, 6n, 7n, 8n]);

      expect(hash1).not.toBe(hash2);
    });

    it('handles zero values', () => {
      const hash = computePoseidonHash([0n, 0n, 0n, 0n]);
      expect(hash).toBeDefined();
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe('splitHashToFieldElements', () => {
    it('splits a 64-char hex hash into hi and lo bigints', () => {
      const hash = 'a'.repeat(32) + 'b'.repeat(32);
      const { hi, lo } = splitHashToFieldElements(hash);

      expect(typeof hi).toBe('bigint');
      expect(typeof lo).toBe('bigint');
      expect(hi).not.toBe(lo);
    });

    it('produces consistent results for the same hash', () => {
      const hash = '0123456789abcdef'.repeat(4);
      const split1 = splitHashToFieldElements(hash);
      const split2 = splitHashToFieldElements(hash);

      expect(split1.hi).toBe(split2.hi);
      expect(split1.lo).toBe(split2.lo);
    });

    it('handles all-zero hash', () => {
      const hash = '0'.repeat(64);
      const { hi, lo } = splitHashToFieldElements(hash);
      expect(hi).toBe(0n);
      expect(lo).toBe(0n);
    });
  });

  describe('computeManifestCommitment', () => {
    it('returns a hex string', () => {
      const commitment = computeManifestCommitment(
        '1a2b3c', // poseidonHash (hex)
        'abcd1234'.repeat(8), // manifestHash (64-char hex)
      );

      expect(commitment).toBeDefined();
      expect(typeof commitment).toBe('string');
      expect(commitment).toMatch(/^[0-9a-f]+$/);
    });

    it('produces different commitments for different manifest hashes', () => {
      const poseidonHash = 'deadbeef';
      const c1 = computeManifestCommitment(poseidonHash, 'a'.repeat(64));
      const c2 = computeManifestCommitment(poseidonHash, 'b'.repeat(64));

      expect(c1).not.toBe(c2);
    });

    it('produces different commitments for different poseidon hashes', () => {
      const manifestHash = 'c'.repeat(64);
      const c1 = computeManifestCommitment('aaa', manifestHash);
      const c2 = computeManifestCommitment('bbb', manifestHash);

      expect(c1).not.toBe(c2);
    });
  });

  describe('CIRCUIT_VERSION', () => {
    it('is a semver-like string', () => {
      expect(CIRCUIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  // Integration tests — exercise generateZkProof + verifyZkProof against the
  // real snarkjs runtime + compiled circuit artifacts. CI builds the
  // artifacts via services/worker/circuits/build.sh before running this
  // suite (see .github/workflows/ci.yml "Build zk circuit artifacts" step).
  // For local dev: run `npm run build:circuit` from services/worker once.
  // The fail-loud existence check below is the canary — if artifacts are
  // missing the suite errors at module load, NOT silently skips, so a
  // broken build pipeline can never look like 'passing tests'.
  describe('generateZkProof + verifyZkProof (integration)', () => {
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { existsSync } = require('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolve } = require('path');
      const artifactsDir = resolve(__dirname, '../../circuits/artifacts');
      const required = [
        resolve(artifactsDir, 'extraction-proof_js/extraction-proof.wasm'),
        resolve(artifactsDir, 'extraction-proof_final.zkey'),
        resolve(artifactsDir, 'verification_key.json'),
      ];
      const missing = required.filter((p: string) => !existsSync(p));
      if (missing.length > 0) {
        throw new Error(
          `zk-proof integration tests require compiled circuit artifacts. Missing:\n  ${missing.join('\n  ')}\nRun: cd services/worker && npm run build:circuit`,
        );
      }
    }

    it('generates a valid proof that verifies', async () => {
      const documentChunks = [42n, 1337n, 999n, 777n];
      const manifestHash = 'a1b2c3d4e5f6'.padEnd(64, '0');

      const result = await generateZkProof({
        documentChunks,
        manifestHash,
      });

      expect(result).toBeDefined();
      expect(result.proof).toBeDefined();
      expect(result.publicSignals).toBeInstanceOf(Array);
      expect(result.publicSignals.length).toBe(2); // poseidonHash, manifestCommitment
      expect(result.proofProtocol).toBe('plonk');
      expect(result.circuitVersion).toBe(CIRCUIT_VERSION);
      expect(result.generationTimeMs).toBeGreaterThan(0);
      expect(result.poseidonHash).toBeDefined();

      // Verify the proof
      const verified = await verifyZkProof(result.proof, result.publicSignals);
      expect(verified).toBe(true);
    }, 30_000); // 30s timeout for proof generation

    it('rejects tampered public signals', async () => {
      const documentChunks = [10n, 20n, 30n, 40n];
      const manifestHash = 'deadbeef'.repeat(8);

      const result = await generateZkProof({
        documentChunks,
        manifestHash,
      });

      // Tamper with poseidonHash signal
      const tamperedSignals = [...result.publicSignals];
      tamperedSignals[0] = '999999999999';

      const verified = await verifyZkProof(result.proof, tamperedSignals);
      expect(verified).toBe(false);
    }, 30_000);

    it('different documents produce different proofs', async () => {
      const manifestHash = 'cafe'.repeat(16);

      const result1 = await generateZkProof({
        documentChunks: [1n, 2n, 3n, 4n],
        manifestHash,
      });

      const result2 = await generateZkProof({
        documentChunks: [5n, 6n, 7n, 8n],
        manifestHash,
      });

      // Different documents → different poseidon hashes
      expect(result1.poseidonHash).not.toBe(result2.poseidonHash);
      // Different public signals
      expect(result1.publicSignals[0]).not.toBe(result2.publicSignals[0]);
    }, 60_000);
  });
});
