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

export const SUPPORTED_RECEIPT_ALGORITHM = 'RSA-SHA256';
export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;

export interface ComputeIdReceiptInput {
  passport_id: string;
  status: string;
  issued_at: string;
  expires_at: string;
  key_id: string;
  receipt_signature: string;
  receipt_algorithm: string;
  receipt_payload: string;
  signature_valid?: boolean | null;
  [extra: string]: unknown;
}

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
  | 'not_yet_valid';

export type ReceiptVerdict =
  | { ok: true; passportId: string; issuedAt: Date; expiresAt: Date; signedPayload: Record<string, unknown> }
  | { ok: false; reason: ReceiptFailure };

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64Strict(value: string): Buffer | null {
  if (!value || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return buf.length > 0 ? buf : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

  if (sPassport !== args.expectedPassportId) return fail('passport_id_mismatch');
  if (sStatus !== 'active') return fail('status_not_active');

  const expiresAt = new Date(sExpires);
  if (Number.isNaN(expiresAt.getTime())) return fail('malformed_payload');
  if (now.getTime() >= expiresAt.getTime()) return fail('expired');

  const issuedAt = typeof sIssued === 'string' ? new Date(sIssued) : now;
  if (Number.isNaN(issuedAt.getTime())) return fail('malformed_payload');
  if (issuedAt.getTime() > now.getTime() + skewMs) return fail('not_yet_valid');

  return { ok: true, passportId: sPassport, issuedAt, expiresAt, signedPayload: signed };
}
