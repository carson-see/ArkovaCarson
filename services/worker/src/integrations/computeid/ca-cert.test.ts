/**
 * ComputeID CA pin — loader + key_id derivation.
 *
 * `__fixtures__/computeid-ca.pem` is the REAL public CA served by
 * `GET https://api.aicomputeid.com/v1/ca/cert` on 2026-09-07 (RSA-2048,
 * self-signed root, C=CY, valid 2026-08-16 → 2036-08-13). Public material —
 * safe to commit. The key_id assertion is the value their API publishes
 * alongside it (`"key_id":"ebb276c2f18ed34f"`), so this test pins that our
 * derivation matches theirs byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPinnedCa, deriveKeyId } from './ca-cert.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_CA_PEM = readFileSync(path.join(here, '__fixtures__', 'computeid-ca.pem'), 'utf8');

describe('loadPinnedCa (ComputeID CA pin)', () => {
  it('parses the real ComputeID CA and derives the key_id their API publishes (ebb276c2f18ed34f)', () => {
    const ca = loadPinnedCa(REAL_CA_PEM, new Date('2026-09-07T00:00:00Z'));
    expect(ca.kind).toBe('certificate');
    expect(ca.keyId).toBe('ebb276c2f18ed34f');
    expect(ca.subject).toContain('CN=ComputeID-CA');
    expect(ca.isCa).toBe(true);
    expect(ca.publicKey.asymmetricKeyType).toBe('rsa');
  });

  it('rejects the CA outside its validity window (clock injected, never wall-clock)', () => {
    expect(() => loadPinnedCa(REAL_CA_PEM, new Date('2040-01-01T00:00:00Z'))).toThrow(/expired/);
    expect(() => loadPinnedCa(REAL_CA_PEM, new Date('2020-01-01T00:00:00Z'))).toThrow(/not yet valid/);
  });

  it('accepts a bare SPKI public-key PEM (test / staging pin) and derives key_id identically', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const ca = loadPinnedCa(pem);
    expect(ca.kind).toBe('public-key');
    expect(ca.isCa).toBe(false);
    expect(ca.keyId).toBe(deriveKeyId(publicKey));
    expect(ca.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects empty, garbage, and non-RSA material', () => {
    expect(() => loadPinnedCa('')).toThrow();
    expect(() => loadPinnedCa('   ')).toThrow();
    expect(() => loadPinnedCa('not a pem')).toThrow();
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    expect(() => loadPinnedCa(pem)).toThrow(/RSA/);
  });
});
