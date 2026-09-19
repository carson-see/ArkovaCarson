import { describe, expect, it } from 'vitest';
import registry from '../../worker/proof-keys.public.json';
import { KEYS_JSON } from './index';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function ed25519XFromPem(pem: string): string {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----|\s/gu, '')),
    (character) => character.charCodeAt(0),
  );
  // Ed25519 SubjectPublicKeyInfo is a fixed 12-byte prefix followed by 32 bytes.
  expect(Array.from(der.slice(0, 12))).toEqual([48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0]);
  expect(der).toHaveLength(44);
  return base64Url(der.slice(12));
}

describe('published proof-signing keys', () => {
  it('publishes every active worker registry key under verifier-contract field names', () => {
    const active = registry.keys.filter((key) => key.status === 'active');
    expect(KEYS_JSON.keys).toEqual(active.map((key) => ({ kid: key.id, alg: key.alg, pem: key.public_key_pem })));
  });

  it('binds kid, PEM, and did:web-compatible Ed25519 JWK material', () => {
    expect(KEYS_JSON.keys).toHaveLength(1);
    const key = KEYS_JSON.keys[0]!;
    expect(key.kid).toBe('arkova-proof-2026-q2');
    expect(key.alg).toBe('Ed25519');
    expect(ed25519XFromPem(key.pem)).toBe('E95nHQxUy2VbBqdFSiVmmbz5Y1ChmF5LLekUikHtX2I');
    expect(key.pem).not.toContain('PRIVATE');
  });

  it('does not retain the false production-disabled notice', () => {
    expect(KEYS_JSON.notice).not.toMatch(/not yet enabled|no signing keys/i);
    expect(KEYS_JSON.notice).toContain('signing_key_id');
  });
});
