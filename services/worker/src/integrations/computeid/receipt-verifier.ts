/**
 * Offline verification of a ComputeID `verification_receipt`.
 *
 * This is the "no API call, no uptime dependency" admission promise, stated
 * honestly: what ComputeID's CA actually signs is the RSA-SHA256 receipt
 * (`receipt_payload`), not the passport itself, and the CA publishes no
 * post-quantum key — so THIS is the offline-verifiable artifact.
 *
 * Trust boundary: the signature is checked over the exact `receipt_payload`
 * bytes as delivered (never re-serialized), and every decision below reads
 * from the parsed SIGNED payload. The outer receipt fields are unsigned
 * copies; disagreement is rejected outright rather than resolved.
 */
import { constants, verify as rsaVerify } from 'node:crypto';
import type { PinnedCa } from './ca-cert.js';
import { isRecord, type ComputeIdVerificationReceiptT } from './schemas.js';

export const SUPPORTED_RECEIPT_ALGORITHM = 'RSA-SHA256';
export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;

/** The Zod-parsed receipt (passthrough keeps unknown extras). One wire type, defined once in schemas.ts. */
export type ComputeIdReceiptInput = ComputeIdVerificationReceiptT;

export type ReceiptFailure =
  | 'unsupported_algorithm'
  | 'key_id_mismatch'
  | 'malformed_signature'
  | 'invalid_signature'
  | 'malformed_payload'
  | 'payload_field_mismatch'
  | 'passport_id_mismatch'
  | 'status_not_active'
  | 'expired'
  | 'not_yet_valid'
  | 'ca_not_valid'
  | 'passport_signature_invalid';

export type ReceiptVerdict =
  | { ok: true; passportId: string; issuedAt: Date | null; expiresAt: Date }
  | { ok: false; reason: ReceiptFailure };

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64Strict(value: string): Buffer | null {
  if (!value || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return buf.length > 0 ? buf : null;
}

const fail = (reason: ReceiptFailure): ReceiptVerdict => ({ ok: false, reason });

export function verifyComputeIdReceipt(args: {
  receipt: ComputeIdReceiptInput;
  ca: PinnedCa;
  expectedPassportId: string;
  now?: Date;
  maxClockSkewSeconds?: number;
}): ReceiptVerdict {
  const { receipt, ca } = args;
  const now = args.now ?? new Date();
  const skewMs = (args.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS) * 1000;

  if (receipt.receipt_algorithm !== SUPPORTED_RECEIPT_ALGORITHM) return fail('unsupported_algorithm');
  if (receipt.key_id !== ca.keyId) return fail('key_id_mismatch');
  // The pin's validity window is a per-verification property, not a per-boot
  // side effect: a long-lived instance must stop trusting an expired CA.
  if (ca.notBefore && now.getTime() < ca.notBefore.getTime()) return fail('ca_not_valid');
  if (ca.notAfter && now.getTime() > ca.notAfter.getTime()) return fail('ca_not_valid');

  const signature = decodeBase64Strict(receipt.receipt_signature);
  if (!signature) return fail('malformed_signature');

  let valid: boolean;
  try {
    valid = rsaVerify(
      'sha256',
      Buffer.from(receipt.receipt_payload, 'utf8'),
      { key: ca.publicKey, padding: constants.RSA_PKCS1_PADDING },
      signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) return fail('invalid_signature');

  let signed: unknown;
  try {
    signed = JSON.parse(receipt.receipt_payload);
  } catch {
    return fail('malformed_payload');
  }
  if (!isRecord(signed)) return fail('malformed_payload');

  const sPassport = signed.passport_id;
  const sStatus = signed.status;
  const sExpires = signed.expires_at;
  const sIssued = signed.issued_at;
  if (typeof sPassport !== 'string' || typeof sStatus !== 'string' || typeof sExpires !== 'string') {
    return fail('malformed_payload');
  }

  // Unsigned outer copies must agree with the signed truth.
  if (receipt.passport_id !== sPassport || receipt.status !== sStatus || receipt.expires_at !== sExpires) {
    return fail('payload_field_mismatch');
  }
  if (typeof sIssued === 'string' && receipt.issued_at !== sIssued) return fail('payload_field_mismatch');
  if (typeof signed.key_id === 'string' && signed.key_id !== receipt.key_id) return fail('payload_field_mismatch');
  if (
    typeof signed.signature_valid === 'boolean'
    && typeof receipt.signature_valid === 'boolean'
    && signed.signature_valid !== receipt.signature_valid
  ) {
    return fail('payload_field_mismatch');
  }

  if (sPassport.toLowerCase() !== args.expectedPassportId.toLowerCase()) return fail('passport_id_mismatch');
  if (sStatus !== 'active') return fail('status_not_active');
  // The CA attests the passport's own signature checks inside the receipt. A
  // receipt that says the passport failed verification is not proof of a valid
  // passport, whatever `status` says. Absent flags are tolerated (not attested).
  if (signed.signature_valid === false || signed.pq_signature_valid === false) return fail('passport_signature_invalid');

  const expiresAt = new Date(sExpires);
  if (Number.isNaN(expiresAt.getTime())) return fail('malformed_payload');
  if (now.getTime() >= expiresAt.getTime()) return fail('expired');

  let issuedAt: Date | null = null;
  if (typeof sIssued === 'string') {
    issuedAt = new Date(sIssued);
    if (Number.isNaN(issuedAt.getTime())) return fail('malformed_payload');
    if (issuedAt.getTime() > now.getTime() + skewMs) return fail('not_yet_valid');
  }

  return { ok: true, passportId: sPassport.toLowerCase(), issuedAt, expiresAt };
}
