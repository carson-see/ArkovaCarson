/**
 * GOLDEN (SCRUM-4501): offline verification of REAL, partner-signed ComputeID
 * receipts — the hard gate in front of flipping ENABLE_COMPUTEID_INTEGRATION.
 *
 * `receipt-verifier.test.ts` proves the verifier's policy against receipts we
 * sign ourselves. That can only ever prove we are self-consistent. This file
 * proves the thing that actually matters for activation: that ComputeID's own
 * signer, over its own bytes, under the CA we pinned from `/v1/ca/cert`,
 * verifies with the code that will run in production.
 *
 * Fixture: `__fixtures__/real-verify-receipts.json` — the two
 * `GET /v1/agents/{id}/verify` responses captured 2026-09-07T18:54Z with
 * Arkova's partner API key. Public material only (see the fixture's `_note`).
 *
 * CLOCK: real receipts live **five minutes** (`issued_at` → `expires_at`), so
 * these would be `expired` against a wall clock within minutes of capture. The
 * test injects a fixed `now` inside each receipt's own signed window. That is
 * the ONLY accommodation made — the expiry rule itself is not relaxed anywhere,
 * and the `expired` cases below prove the boundary is still enforced on these
 * exact bytes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPinnedCa } from './ca-cert.js';
import { ComputeIdVerificationReceipt } from './schemas.js';
import { verifyComputeIdReceipt } from './receipt-verifier.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_CA_PEM = readFileSync(path.join(here, '__fixtures__', 'computeid-ca.pem'), 'utf8');

interface RealCapture {
  _receiptValiditySeconds: number;
  passports: {
    label: string;
    passportId: string;
    response: {
      passport_id: string;
      status: string;
      verification_receipt: Record<string, unknown>;
    };
  }[];
}

const capture = JSON.parse(
  readFileSync(path.join(here, '__fixtures__', 'real-verify-receipts.json'), 'utf8'),
) as RealCapture;

/** A clock one second after the receipt was issued — inside its own signed window. */
function insideWindow(issuedAt: string): Date {
  return new Date(Date.parse(issuedAt) + 1_000);
}

describe('GOLDEN: real ComputeID receipts verify offline against the pinned CA', () => {
  const ca = loadPinnedCa(REAL_CA_PEM);

  it('pins that the fixture carries both passports ComputeID issued to Arkova', () => {
    expect(capture.passports).toHaveLength(2);
    expect(capture.passports.map((p) => p.passportId).sort()).toEqual([
      'adff394c-131d-4a5a-b7d5-a799d92af678',
      'b390e5e6-c79d-4f02-9a42-212494b1fd44',
    ]);
  });

  for (const entry of capture.passports) {
    describe(`${entry.label} (${entry.passportId})`, () => {
      // Parse with the REAL production schema: a wire-shape drift is a failure
      // here, not a silently-coerced object.
      const receipt = ComputeIdVerificationReceipt.parse(entry.response.verification_receipt);
      const now = insideWindow(receipt.issued_at);

      it('verifies with the production verifier under a clock inside its signed window', () => {
        const verdict = verifyComputeIdReceipt({ receipt, ca, expectedPassportId: entry.passportId, now });
        expect(verdict).toMatchObject({ ok: true, passportId: entry.passportId });
      });

      it('is signed by the key_id our pin derives (ebb276c2f18ed34f), RSA-SHA256', () => {
        expect(receipt.key_id).toBe(ca.keyId);
        expect(receipt.key_id).toBe('ebb276c2f18ed34f');
        expect(receipt.receipt_algorithm).toBe('RSA-SHA256');
      });

      it('carries the partner-documented five-minute life, and the outer copies agree with the signed payload', () => {
        const signed = JSON.parse(receipt.receipt_payload) as Record<string, unknown>;
        expect(Date.parse(receipt.expires_at) - Date.parse(receipt.issued_at)).toBe(
          capture._receiptValiditySeconds * 1000,
        );
        expect(signed.passport_id).toBe(entry.passportId);
        expect(signed.status).toBe('active');
        expect(signed.signature_valid).toBe(true);
        expect(signed.expires_at).toBe(receipt.expires_at);
        expect(signed.issued_at).toBe(receipt.issued_at);
      });

      it('EXPIRY IS NOT RELAXED: the same real bytes are rejected at expires_at', () => {
        const atExpiry = new Date(Date.parse(receipt.expires_at));
        expect(verifyComputeIdReceipt({ receipt, ca, expectedPassportId: entry.passportId, now: atExpiry }))
          .toEqual({ ok: false, reason: 'expired' });
      });

      it('rejects a single-character tamper of the signed payload', () => {
        const tampered = {
          ...receipt,
          receipt_payload: receipt.receipt_payload.replace('"status":"active"', '"status":"Active"'),
        };
        expect(tampered.receipt_payload).not.toBe(receipt.receipt_payload);
        expect(verifyComputeIdReceipt({ receipt: tampered, ca, expectedPassportId: entry.passportId, now }))
          .toEqual({ ok: false, reason: 'invalid_signature' });
      });

      it('rejects the receipt when presented for a different passport', () => {
        const other = capture.passports.find((p) => p.passportId !== entry.passportId)!;
        expect(verifyComputeIdReceipt({ receipt, ca, expectedPassportId: other.passportId, now }))
          .toEqual({ ok: false, reason: 'passport_id_mismatch' });
      });
    });
  }
});
