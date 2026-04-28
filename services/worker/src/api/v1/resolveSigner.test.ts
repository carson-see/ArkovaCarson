/**
 * Tests for `resolveSigner()` in verify-proof.ts (SCRUM-900 follow-up).
 *
 * Pins the resolution order:
 *   1. PROOF_SIGNING_KMS_KEY + PROOF_SIGNING_KEY_ID  → KMS signer
 *   2. PROOF_SIGNING_KEY_PEM + PROOF_SIGNING_KEY_ID  → static-PEM signer
 *   3. neither / no key id                            → null (503 path)
 *
 * Plus the module-scope memo: subsequent calls return the same instance
 * once the cache is warm (until __resetSignerCacheForTests is called).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { resolveSigner, __resetSignerCacheForTests } from './verify-proof.js';

const KMS_KEY_NAME =
  'projects/arkova1/locations/us-central1/keyRings/proof-signing/cryptoKeys/proof-ed25519/cryptoKeyVersions/1';
const KEY_ID = 'arkova-proof-2026-04';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.PROOF_SIGNING_KMS_KEY;
  delete process.env.PROOF_SIGNING_KEY_PEM;
  delete process.env.PROOF_SIGNING_KEY_ID;
  __resetSignerCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __resetSignerCacheForTests();
});

describe('resolveSigner — env-driven resolution order (SCRUM-900)', () => {
  it('returns null when PROOF_SIGNING_KEY_ID is unset', () => {
    expect(resolveSigner()).toBeNull();
  });

  it('returns null when KEY_ID is set but neither KMS nor PEM is configured', () => {
    process.env.PROOF_SIGNING_KEY_ID = KEY_ID;
    expect(resolveSigner()).toBeNull();
  });

  it('returns the KMS signer when PROOF_SIGNING_KMS_KEY + KEY_ID are set', () => {
    process.env.PROOF_SIGNING_KMS_KEY = KMS_KEY_NAME;
    process.env.PROOF_SIGNING_KEY_ID = KEY_ID;
    const signer = resolveSigner();
    expect(signer).not.toBeNull();
    expect(signer?.keyId).toBe(KEY_ID);
    expect(typeof signer?.sign).toBe('function');
  });

  it('KMS takes precedence over PEM when both are set (production-priority rule)', () => {
    process.env.PROOF_SIGNING_KMS_KEY = KMS_KEY_NAME;
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.PROOF_SIGNING_KEY_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    process.env.PROOF_SIGNING_KEY_ID = KEY_ID;
    const signer = resolveSigner();
    // We can't introspect the signer fn directly, but we can verify the
    // KMS branch was taken: the static-PEM signer constructs a real Node
    // private-key from the PEM eagerly; if the PEM were taken, malformed
    // PEM would throw. Let's set malformed PEM and confirm KMS still
    // resolves cleanly:
    expect(signer).not.toBeNull();
    expect(signer?.keyId).toBe(KEY_ID);

    __resetSignerCacheForTests();
    process.env.PROOF_SIGNING_KEY_PEM = 'NOT-A-VALID-PEM';
    const signer2 = resolveSigner();
    expect(signer2).not.toBeNull(); // KMS path doesn't touch PEM
  });

  it('falls back to PEM when only PROOF_SIGNING_KEY_PEM + KEY_ID are set', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.PROOF_SIGNING_KEY_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    process.env.PROOF_SIGNING_KEY_ID = KEY_ID;
    const signer = resolveSigner();
    expect(signer).not.toBeNull();
    expect(signer?.keyId).toBe(KEY_ID);
  });

  it('memoizes the resolved signer across calls (no per-request re-build)', () => {
    process.env.PROOF_SIGNING_KMS_KEY = KMS_KEY_NAME;
    process.env.PROOF_SIGNING_KEY_ID = KEY_ID;
    const a = resolveSigner();
    const b = resolveSigner();
    expect(a).toBe(b); // same object reference — memoized
  });

  it('memoizes the null path too (env unchanged → no re-read)', () => {
    const a = resolveSigner();
    const b = resolveSigner();
    expect(a).toBeNull();
    expect(b).toBeNull();
    // Even after we set env vars, the memo holds until __reset is called.
    process.env.PROOF_SIGNING_KMS_KEY = KMS_KEY_NAME;
    process.env.PROOF_SIGNING_KEY_ID = KEY_ID;
    expect(resolveSigner()).toBeNull(); // still null — cache stale by design
    __resetSignerCacheForTests();
    expect(resolveSigner()).not.toBeNull(); // re-resolves after reset
  });
});
