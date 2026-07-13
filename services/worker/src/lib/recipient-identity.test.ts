/**
 * SCRUM-2484 — recipient identifier: unsalted sha256(email) → keyed HMAC + possession-proof.
 *
 * RED-first (TDD §0.1). The recipient identifier was a bare sha256(email):
 *   1. It is publicly projected (recipient_identifier_hash in public metadata +
 *      get_public_anchor.recipient_identifier), so ANYONE can compute
 *      sha256(known_email) and enumerate which credentials belong to a person —
 *      an offline correlation / rainbow-table attack with no server secret.
 *   2. Hash-equality could be mistaken for a possession proof of the email.
 *
 * The fix:
 *   - hashRecipientEmail() = keyed HMAC-SHA256(pepper, normalized_email). Without
 *     the server pepper the hash cannot be precomputed → no offline enumeration.
 *   - determinism under a fixed pepper; different peppers ⇒ different digests.
 *   - a possession-proof primitive: hash-equality is NOT accepted as proof;
 *     linking a credential to a NON-self recipient requires a verified
 *     possession token (email round-trip / signed challenge).
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  hashRecipientEmail,
  verifyRecipientPossession,
  RecipientPepperUnavailableError,
} from './recipient-identity.js';

const TEST_PEPPER = 'test-pepper-value-0123456789abcdef';

describe('hashRecipientEmail (SCRUM-2484 keyed HMAC)', () => {
  it('produces a 64-char hex HMAC-SHA256 digest', () => {
    const h = hashRecipientEmail('ada@example.com', TEST_PEPPER);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic under a fixed pepper', () => {
    const a = hashRecipientEmail('ada@example.com', TEST_PEPPER);
    const b = hashRecipientEmail('ada@example.com', TEST_PEPPER);
    expect(a).toBe(b);
  });

  it('normalizes case + surrounding whitespace before hashing', () => {
    const a = hashRecipientEmail('Ada@Example.com', TEST_PEPPER);
    const b = hashRecipientEmail('  ada@example.com  ', TEST_PEPPER);
    expect(a).toBe(b);
  });

  it('is NOT a bare sha256 of the email (the pepper changes the output)', () => {
    // The whole point: the same email under a DIFFERENT pepper yields a
    // different digest, so an attacker without the pepper cannot precompute it.
    const withPepperA = hashRecipientEmail('ada@example.com', 'pepper-A');
    const withPepperB = hashRecipientEmail('ada@example.com', 'pepper-B');
    expect(withPepperA).not.toBe(withPepperB);
  });

  it('throws when the pepper is missing/empty (fail closed, never fall back to bare sha256)', () => {
    expect(() => hashRecipientEmail('ada@example.com', '')).toThrow(
      RecipientPepperUnavailableError,
    );
    expect(() => hashRecipientEmail('ada@example.com', undefined)).toThrow(
      RecipientPepperUnavailableError,
    );
  });

  it('returns undefined for an empty/blank email (no identifier to hash)', () => {
    expect(hashRecipientEmail('', TEST_PEPPER)).toBeUndefined();
    expect(hashRecipientEmail('   ', TEST_PEPPER)).toBeUndefined();
  });
});

describe('verifyRecipientPossession (SCRUM-2484 possession-proof)', () => {
  it('REJECTS hash-equality as proof of possession', () => {
    const emailHash = hashRecipientEmail('ada@example.com', TEST_PEPPER)!;
    // Passing the hash itself as the "proof" must NOT verify — hash-equality is
    // not possession.
    const result = verifyRecipientPossession({
      emailHash,
      proof: { kind: 'hash_equality', value: emailHash },
      pepper: TEST_PEPPER,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('hash_equality_not_accepted');
  });

  it('accepts a valid signed possession token that matches the email hash', () => {
    const email = 'ada@example.com';
    const emailHash = hashRecipientEmail(email, TEST_PEPPER)!;
    // A possession token is an HMAC over the email hash + a nonce with the
    // server pepper — only the server (round-trip verified) can mint it.
    const token = mintTestPossessionToken(emailHash, 'nonce-1', TEST_PEPPER);
    const result = verifyRecipientPossession({
      emailHash,
      proof: { kind: 'signed_challenge', value: token, nonce: 'nonce-1' },
      pepper: TEST_PEPPER,
    });
    expect(result.verified).toBe(true);
  });

  it('rejects a signed token minted for a DIFFERENT email hash', () => {
    const emailHash = hashRecipientEmail('ada@example.com', TEST_PEPPER)!;
    const otherHash = hashRecipientEmail('mallory@example.com', TEST_PEPPER)!;
    const token = mintTestPossessionToken(otherHash, 'nonce-1', TEST_PEPPER);
    const result = verifyRecipientPossession({
      emailHash,
      proof: { kind: 'signed_challenge', value: token, nonce: 'nonce-1' },
      pepper: TEST_PEPPER,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('token_mismatch');
  });

  it('rejects a tampered token', () => {
    const emailHash = hashRecipientEmail('ada@example.com', TEST_PEPPER)!;
    const token = mintTestPossessionToken(emailHash, 'nonce-1', TEST_PEPPER);
    const tampered = token.slice(0, -2) + (token.endsWith('00') ? 'ff' : '00');
    const result = verifyRecipientPossession({
      emailHash,
      proof: { kind: 'signed_challenge', value: tampered, nonce: 'nonce-1' },
      pepper: TEST_PEPPER,
    });
    expect(result.verified).toBe(false);
  });
});

/** Mirror the server's possession-token construction for the positive test. */
function mintTestPossessionToken(emailHash: string, nonce: string, pepper: string): string {
  // Must match recipient-identity.ts mintPossessionToken.
  return hmacHex(`${emailHash}:${nonce}`, pepper);
}

function hmacHex(value: string, key: string): string {
  // Local mirror of node:crypto HMAC for the test's expected token.
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
