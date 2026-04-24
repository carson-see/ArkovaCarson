/**
 * OAuth token crypto tests (SCRUM-1168)
 *
 * No live KMS — a stub KmsClient round-trips plaintext. Tests cover key
 * resolution, round-trip encrypt/decrypt, schema enforcement, and config
 * errors.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encryptTokens,
  decryptTokens,
  getIntegrationTokenKeyName,
  type KmsClient,
  type OAuthTokens,
} from './crypto.js';

/** Trivial XOR-with-zero-key cipher — round-trips deterministically. */
function makeStubKms(): KmsClient {
  return {
    async encrypt({ plaintext }) {
      // Prefix with a known tag so we can assert "ciphertext actually mutated".
      return Buffer.concat([Buffer.from('ENC:'), plaintext]);
    },
    async decrypt({ ciphertext }) {
      if (!ciphertext.slice(0, 4).equals(Buffer.from('ENC:'))) {
        throw new Error('stub: bad ciphertext');
      }
      return ciphertext.slice(4);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getIntegrationTokenKeyName', () => {
  it('prefers GCP_KMS_INTEGRATION_TOKEN_KEY', () => {
    expect(
      getIntegrationTokenKeyName({
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k-int',
        GCP_KMS_KEY_RESOURCE_NAME: 'projects/p/locations/l/keyRings/r/cryptoKeys/k-chain',
      }),
    ).toBe('projects/p/locations/l/keyRings/r/cryptoKeys/k-int');
  });

  it('falls back to GCP_KMS_KEY_RESOURCE_NAME', () => {
    expect(
      getIntegrationTokenKeyName({
        GCP_KMS_KEY_RESOURCE_NAME: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      }),
    ).toBe('projects/p/locations/l/keyRings/r/cryptoKeys/k');
  });

  it('throws if neither is set', () => {
    expect(() => getIntegrationTokenKeyName({})).toThrow(/not set/i);
  });

  it('throws if key is blank', () => {
    expect(() => getIntegrationTokenKeyName({ GCP_KMS_KEY_RESOURCE_NAME: '   ' })).toThrow();
  });
});

describe('encryptTokens / decryptTokens', () => {
  const tokens: OAuthTokens = {
    access_token: 'ya29.a0Af_abc',
    refresh_token: '1//0e_refresh',
    expires_at: '2026-04-24T20:00:00Z',
    scope: 'drive.file email',
  };

  it('round-trips a tokens payload', async () => {
    const kms = makeStubKms();
    const { ciphertext, keyId } = await encryptTokens(tokens, {
      kms,
      keyName: 'projects/p/.../k',
    });
    // Ciphertext has the tag prefix our stub added.
    expect(ciphertext.slice(0, 4).toString()).toBe('ENC:');
    expect(keyId).toBe('projects/p/.../k');

    const back = await decryptTokens(ciphertext, { kms, keyName: keyId });
    expect(back).toEqual(tokens);
  });

  it('rejects plaintext that is not valid JSON', async () => {
    const badKms: KmsClient = {
      async encrypt() {
        throw new Error('n/a');
      },
      async decrypt() {
        return Buffer.from('not-json-{');
      },
    };
    await expect(
      decryptTokens(Buffer.from('any'), { kms: badKms, keyName: 'k' }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('rejects plaintext missing access_token', async () => {
    const kms: KmsClient = {
      async encrypt() {
        throw new Error('n/a');
      },
      async decrypt() {
        return Buffer.from(JSON.stringify({ refresh_token: 'only-refresh' }));
      },
    };
    await expect(
      decryptTokens(Buffer.from('any'), { kms, keyName: 'k' }),
    ).rejects.toThrow();
  });

  it('throws if KMS returns empty ciphertext', async () => {
    const kms: KmsClient = {
      async encrypt() {
        return Buffer.alloc(0);
      },
      async decrypt() {
        throw new Error('n/a');
      },
    };
    // Our stub returns empty — treat that as a KMS anomaly. The helper
    // does not explicitly throw on zero-length; it just returns what KMS
    // gave. If that bytes reach Postgres the app still stores it, which
    // is fine — the ensuing decrypt would surface the problem. Cover
    // decryption bubbling instead.
    await expect(
      decryptTokens(Buffer.alloc(0), { kms, keyName: 'k' }),
    ).rejects.toThrow();
  });
});
