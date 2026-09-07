/**
 * Offline verification of a ComputeID `verification_receipt` against the
 * pinned CA. Keys are generated per test run; nothing here touches the
 * network. The signed `receipt_payload` string is the ONLY thing trusted —
 * the outer receipt fields are unsigned convenience copies and must agree.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPinnedCa, type PinnedCa } from './ca-cert.js';
import { verifyComputeIdReceipt, type ComputeIdReceiptInput } from './receipt-verifier.js';

const NOW = new Date('2026-09-07T12:00:00Z');
const PASSPORT = '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f';

function rsa() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}
function pin(pub: KeyObject): PinnedCa {
  return loadPinnedCa(pub.export({ type: 'spki', format: 'pem' }) as string);
}
function receiptFor(
  priv: KeyObject,
  ca: PinnedCa,
  opts: { payloadOverride?: Record<string, unknown>; outerOverride?: Record<string, unknown>; rawPayload?: string } = {},
): ComputeIdReceiptInput {
  const payloadObj = {
    passport_id: PASSPORT,
    status: 'active',
    signature_valid: true,
    issued_at: '2026-09-07T11:59:00.000Z',
    expires_at: '2026-09-07T12:30:00.000Z',
    key_id: ca.keyId,
    ...(opts.payloadOverride ?? {}),
  };
  const receipt_payload = opts.rawPayload ?? JSON.stringify(payloadObj);
  const receipt_signature = sign('sha256', Buffer.from(receipt_payload, 'utf8'), priv).toString('base64');
  return {
    passport_id: String(payloadObj.passport_id),
    status: String(payloadObj.status),
    signature_valid: true,
    issued_at: String(payloadObj.issued_at),
    expires_at: String(payloadObj.expires_at),
    key_id: ca.keyId,
    receipt_signature,
    receipt_algorithm: 'RSA-SHA256',
    receipt_payload,
    ...(opts.outerOverride ?? {}),
  };
}

describe('verifyComputeIdReceipt', () => {
  const { publicKey, privateKey } = rsa();
  const ca = pin(publicKey);

  it('accepts a receipt signed by the pinned key for the expected passport', () => {
    const v = verifyComputeIdReceipt({ receipt: receiptFor(privateKey, ca), ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.passportId).toBe(PASSPORT);
      expect(v.expiresAt.toISOString()).toBe('2026-09-07T12:30:00.000Z');
    }
  });

  it('verifies over the EXACT delivered bytes — odd whitespace / key order still verifies, never re-serialized', () => {
    const raw = `{ "status" : "active",\n  "passport_id":"${PASSPORT}", "expires_at":"2026-09-07T12:30:00.000Z","issued_at":"2026-09-07T11:59:00.000Z","key_id":"${ca.keyId}" }`;
    const v = verifyComputeIdReceipt({ receipt: receiptFor(privateKey, ca, { rawPayload: raw }), ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v.ok).toBe(true);
  });

  it('rejects a payload altered after signing', () => {
    const r = receiptFor(privateKey, ca);
    r.receipt_payload = r.receipt_payload.replace('"active"', '"active "');
    const v = verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a receipt signed by a different key', () => {
    const other = rsa();
    const v = verifyComputeIdReceipt({ receipt: receiptFor(other.privateKey, ca), ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a key_id that does not match the pinned CA before touching the signature', () => {
    const r = receiptFor(privateKey, ca, { outerOverride: { key_id: 'deadbeefdeadbeef' } });
    const v = verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'key_id_mismatch' });
  });

  it('rejects an unsupported receipt algorithm', () => {
    const r = receiptFor(privateKey, ca, { outerOverride: { receipt_algorithm: 'RSA-PSS-SHA256' } });
    const v = verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'unsupported_algorithm' });
  });

  it('rejects a malformed (non-base64 / empty) signature', () => {
    const r = receiptFor(privateKey, ca, { outerOverride: { receipt_signature: '!!!not-base64!!!' } });
    expect(verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW })).toEqual({ ok: false, reason: 'malformed_signature' });
    const e = receiptFor(privateKey, ca, { outerOverride: { receipt_signature: '' } });
    expect(verifyComputeIdReceipt({ receipt: e, ca, expectedPassportId: PASSPORT, now: NOW })).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('rejects a validly-signed payload that is not JSON', () => {
    const r = receiptFor(privateKey, ca, { rawPayload: 'this is not json' });
    const v = verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'malformed_payload' });
  });

  it('trusts the SIGNED payload, not the outer fields — disagreement is rejected', () => {
    // Outer says active, signed payload says revoked. Attacker edits the unsigned copy.
    const r = receiptFor(privateKey, ca, { payloadOverride: { status: 'revoked' }, outerOverride: { status: 'active' } });
    const v = verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'payload_field_mismatch' });
  });

  it('rejects a passport that is not active in the signed payload', () => {
    const r = receiptFor(privateKey, ca, { payloadOverride: { status: 'revoked' } });
    const v = verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'status_not_active' });
  });

  it('rejects a receipt for a different passport than the one being admitted', () => {
    const v = verifyComputeIdReceipt({ receipt: receiptFor(privateKey, ca), ca, expectedPassportId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', now: NOW });
    expect(v).toEqual({ ok: false, reason: 'passport_id_mismatch' });
  });

  it('rejects an expired receipt and a receipt issued in the future beyond skew', () => {
    const expired = receiptFor(privateKey, ca);
    expect(verifyComputeIdReceipt({ receipt: expired, ca, expectedPassportId: PASSPORT, now: new Date('2026-09-07T12:31:00Z') })).toEqual({ ok: false, reason: 'expired' });
    const future = receiptFor(privateKey, ca, { payloadOverride: { issued_at: '2026-09-07T12:10:00.000Z' } });
    expect(verifyComputeIdReceipt({ receipt: future, ca, expectedPassportId: PASSPORT, now: NOW, maxClockSkewSeconds: 60 })).toEqual({ ok: false, reason: 'not_yet_valid' });
  });

  it('rejects a receipt whose SIGNED payload says the passport signature failed, whatever status says', () => {
    const r = receiptFor(privateKey, ca, { payloadOverride: { signature_valid: false }, outerOverride: { signature_valid: false } });
    expect(verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW })).toEqual({ ok: false, reason: 'passport_signature_invalid' });
    const pq = receiptFor(privateKey, ca, { payloadOverride: { pq_signature_valid: false } });
    expect(verifyComputeIdReceipt({ receipt: pq, ca, expectedPassportId: PASSPORT, now: NOW })).toEqual({ ok: false, reason: 'passport_signature_invalid' });
  });

  it('rejects when outer signature_valid disagrees with the signed one', () => {
    const r = receiptFor(privateKey, ca, { payloadOverride: { signature_valid: false }, outerOverride: { signature_valid: true } });
    expect(verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW })).toEqual({ ok: false, reason: 'payload_field_mismatch' });
  });

  it('enforces the CA validity window per verification (real ComputeID CA, clock beyond notAfter) before touching the signature', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realCa = loadPinnedCa(readFileSync(path.join(here, '__fixtures__', 'computeid-ca.pem'), 'utf8'), new Date('2026-09-07T00:00:00Z'));
    const r = receiptFor(privateKey, realCa); // key_id will match the real CA; signature will not — the window check must come first
    expect(verifyComputeIdReceipt({ receipt: r, ca: realCa, expectedPassportId: PASSPORT, now: new Date('2040-01-01T00:00:00Z') })).toEqual({ ok: false, reason: 'ca_not_valid' });
    expect(verifyComputeIdReceipt({ receipt: r, ca: realCa, expectedPassportId: PASSPORT, now: new Date('2020-01-01T00:00:00Z') })).toEqual({ ok: false, reason: 'ca_not_valid' });
  });

  it('reports issuedAt as null (never the wall clock) when the signed payload carries no issued_at', () => {
    const raw = JSON.stringify({ passport_id: PASSPORT, status: 'active', expires_at: '2026-09-07T12:30:00.000Z', key_id: ca.keyId });
    const v = verifyComputeIdReceipt({ receipt: receiptFor(privateKey, ca, { rawPayload: raw }), ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.issuedAt).toBeNull();
  });

  it('compares passport ids case-insensitively (RFC-4122 text is case-insensitive)', () => {
    const v = verifyComputeIdReceipt({ receipt: receiptFor(privateKey, ca), ca, expectedPassportId: PASSPORT.toUpperCase(), now: NOW });
    expect(v.ok).toBe(true);
  });

  it('requires passport_id, status and expires_at INSIDE the signed payload', () => {
    const r = receiptFor(privateKey, ca, { rawPayload: JSON.stringify({ passport_id: PASSPORT, status: 'active' }) });
    const v = verifyComputeIdReceipt({ receipt: r, ca, expectedPassportId: PASSPORT, now: NOW });
    expect(v).toEqual({ ok: false, reason: 'malformed_payload' });
  });
});
