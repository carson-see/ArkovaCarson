/**
 * SCRUM-2484 — recipient identifier hashing + possession-proof.
 *
 * The recipient identifier was a bare `sha256(normalized_email)`. Because that
 * digest is publicly projected (recipient_identifier_hash in the public metadata
 * and get_public_anchor.recipient_identifier), anyone could compute
 * `sha256(known_email)` offline and enumerate which anchored credentials belong
 * to a person — a correlation / rainbow-table attack requiring no server secret.
 *
 * FIX (§1.4): key the hash with a server-side pepper so the digest is an
 * HMAC-SHA256(pepper, email) that cannot be precomputed without the pepper.
 * Additionally, provide a possession-proof primitive: hash-equality is NOT
 * accepted as proof that a caller controls an email — linking a credential to a
 * NON-self recipient must present a verified possession token (email round-trip
 * or signed challenge minted server-side).
 *
 * PEPPER VALUE IS CARSON/RTE-GATED: the actual `RECIPIENT_IDENTIFIER_PEPPER`
 * Secret Manager value + the backfill of existing bare-sha256 rows are gated
 * operations. This module codes the PATH; callers resolve the pepper from
 * config and fail closed (RecipientPepperUnavailableError) when it is unset in
 * production — never silently fall back to the enumerable bare sha256.
 */

import { createHmac } from 'node:crypto';

export class RecipientPepperUnavailableError extends Error {
  constructor() {
    super(
      'RECIPIENT_IDENTIFIER_PEPPER is unset — refusing to hash a recipient identifier. ' +
        'Falling back to bare sha256(email) would re-open the offline-enumeration leak (SCRUM-2484).',
    );
    this.name = 'RecipientPepperUnavailableError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hmacHex(value: string, key: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/**
 * Keyed HMAC-SHA256 of a normalized recipient email. Returns undefined for a
 * blank email (nothing to hash). Throws {@link RecipientPepperUnavailableError}
 * when the pepper is missing — fail closed, never fall back to a bare sha256.
 *
 * The output is 64-char hex, so it remains valid against the existing
 * Sha256HexSchema and the recipient_email_hash / recipient_identifier_hash text
 * columns — an in-place algorithm swap, not a shape change.
 */
export function hashRecipientEmail(email: string, pepper: string | undefined): string | undefined {
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;
  if (!pepper) throw new RecipientPepperUnavailableError();
  return hmacHex(normalized, pepper);
}

/**
 * Mint a possession token binding an email hash to a nonce. Only code holding
 * the server pepper can produce a token that {@link verifyRecipientPossession}
 * accepts — so a token is evidence the server round-tripped possession (e.g. the
 * recipient clicked an emailed link that produced this nonce), not a value the
 * caller can forge from the public email hash.
 */
export function mintPossessionToken(emailHash: string, nonce: string, pepper: string): string {
  if (!pepper) throw new RecipientPepperUnavailableError();
  return hmacHex(`${emailHash}:${nonce}`, pepper);
}

export type RecipientPossessionProof =
  | { kind: 'hash_equality'; value: string }
  | { kind: 'signed_challenge'; value: string; nonce: string };

export interface RecipientPossessionResult {
  verified: boolean;
  reason?: 'hash_equality_not_accepted' | 'token_mismatch' | 'pepper_unavailable' | 'malformed';
}

/**
 * Verify a possession proof for a recipient email hash.
 *
 * - `hash_equality` proofs are ALWAYS rejected: knowing the (public) email hash
 *   is not possession of the email. This is the core of the fix — a linker
 *   cannot claim a credential just by presenting the hash.
 * - `signed_challenge` proofs verify iff the token equals
 *   `mintPossessionToken(emailHash, nonce, pepper)` (constant-time compare).
 */
export function verifyRecipientPossession(input: {
  emailHash: string;
  proof: RecipientPossessionProof;
  pepper: string | undefined;
}): RecipientPossessionResult {
  const { emailHash, proof, pepper } = input;

  if (proof.kind === 'hash_equality') {
    return { verified: false, reason: 'hash_equality_not_accepted' };
  }

  if (!pepper) return { verified: false, reason: 'pepper_unavailable' };
  if (!proof.value || !proof.nonce) return { verified: false, reason: 'malformed' };

  const expected = mintPossessionToken(emailHash, proof.nonce, pepper);
  if (!timingSafeEqualHex(expected, proof.value)) {
    return { verified: false, reason: 'token_mismatch' };
  }
  return { verified: true };
}

/** Constant-time compare of two hex strings of equal length. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
