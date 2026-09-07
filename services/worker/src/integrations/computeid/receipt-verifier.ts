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

interface VerifyArgs {
  receipt: ComputeIdReceiptInput;
  ca: PinnedCa;
  expectedPassportId: string;
  now?: Date;
  maxClockSkewSeconds?: number;
}

/** Algorithm, key id, and the pin's validity window. */
function checkPin(receipt: ComputeIdReceiptInput, ca: PinnedCa, now: Date): ReceiptFailure | null {
  if (receipt.receipt_algorithm !== SUPPORTED_RECEIPT_ALGORITHM) return 'unsupported_algorithm';
  if (receipt.key_id !== ca.keyId) return 'key_id_mismatch';
  // The pin's validity window is a per-verification property, not a per-boot
  // side effect: a long-lived instance must stop trusting an expired CA.
  if (ca.notBefore && now.getTime() < ca.notBefore.getTime()) return 'ca_not_valid';
  if (ca.notAfter && now.getTime() > ca.notAfter.getTime()) return 'ca_not_valid';
  return null;
}

/** RSA-SHA256 (PKCS#1 v1.5) over the exact `receipt_payload` bytes as delivered. */
function checkSignature(receipt: ComputeIdReceiptInput, ca: PinnedCa): ReceiptFailure | null {
  const signature = decodeBase64Strict(receipt.receipt_signature);
  if (!signature) return 'malformed_signature';
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
  return valid ? null : 'invalid_signature';
}

interface SignedFields {
  raw: Record<string, unknown>;
  passportId: string;
  status: string;
  expiresAt: string;
  issuedAt: string | undefined;
}

/** The signed truth: parsed `receipt_payload` with its required string fields. */
function parseSignedPayload(receipt: ComputeIdReceiptInput): SignedFields | 'malformed_payload' {
  let signed: unknown;
  try {
    signed = JSON.parse(receipt.receipt_payload);
  } catch {
    return 'malformed_payload';
  }
  if (!isRecord(signed)) return 'malformed_payload';
  const { passport_id: passportId, status, expires_at: expiresAt, issued_at: issuedAt } = signed;
  if (typeof passportId !== 'string' || typeof status !== 'string' || typeof expiresAt !== 'string') {
    return 'malformed_payload';
  }
  return { raw: signed, passportId, status, expiresAt, issuedAt: typeof issuedAt === 'string' ? issuedAt : undefined };
}

/** Unsigned outer copies must agree with the signed truth; disagreement is rejected, never resolved. */
function checkFieldAgreement(receipt: ComputeIdReceiptInput, signed: SignedFields): ReceiptFailure | null {
  if (receipt.passport_id !== signed.passportId || receipt.status !== signed.status || receipt.expires_at !== signed.expiresAt) {
    return 'payload_field_mismatch';
  }
  if (signed.issuedAt !== undefined && receipt.issued_at !== signed.issuedAt) return 'payload_field_mismatch';
  const { key_id: keyId, signature_valid: signatureValid } = signed.raw;
  if (typeof keyId === 'string' && keyId !== receipt.key_id) return 'payload_field_mismatch';
  if (
    typeof signatureValid === 'boolean'
    && typeof receipt.signature_valid === 'boolean'
    && signatureValid !== receipt.signature_valid
  ) {
    return 'payload_field_mismatch';
  }
  return null;
}

/** What the signed payload says about the passport itself. */
function checkPassportClaims(signed: SignedFields, expectedPassportId: string): ReceiptFailure | null {
  if (signed.passportId.toLowerCase() !== expectedPassportId.toLowerCase()) return 'passport_id_mismatch';
  if (signed.status !== 'active') return 'status_not_active';
  // The CA attests the passport's own signature checks inside the receipt. A
  // receipt that says the passport failed verification is not proof of a valid
  // passport, whatever `status` says. Absent flags are tolerated (not attested).
  if (signed.raw.signature_valid === false || signed.raw.pq_signature_valid === false) return 'passport_signature_invalid';
  return null;
}

/** Expiry (hard) and issue time (bounded by clock skew), both from the signed payload. */
function checkTimes(
  signed: SignedFields,
  now: Date,
  skewMs: number,
): { expiresAt: Date; issuedAt: Date | null } | ReceiptFailure {
  const expiresAt = new Date(signed.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return 'malformed_payload';
  if (now.getTime() >= expiresAt.getTime()) return 'expired';
  if (signed.issuedAt === undefined) return { expiresAt, issuedAt: null };
  const issuedAt = new Date(signed.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) return 'malformed_payload';
  if (issuedAt.getTime() > now.getTime() + skewMs) return 'not_yet_valid';
  return { expiresAt, issuedAt };
}

export function verifyComputeIdReceipt(args: VerifyArgs): ReceiptVerdict {
  const { receipt, ca } = args;
  const now = args.now ?? new Date();
  const skewMs = (args.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS) * 1000;

  const pin = checkPin(receipt, ca, now);
  if (pin) return fail(pin);
  const signature = checkSignature(receipt, ca);
  if (signature) return fail(signature);
  const signed = parseSignedPayload(receipt);
  if (typeof signed === 'string') return fail(signed);
  const agreement = checkFieldAgreement(receipt, signed);
  if (agreement) return fail(agreement);
  const claims = checkPassportClaims(signed, args.expectedPassportId);
  if (claims) return fail(claims);
  const times = checkTimes(signed, now, skewMs);
  if (typeof times === 'string') return fail(times);

  return { ok: true, passportId: signed.passportId.toLowerCase(), issuedAt: times.issuedAt, expiresAt: times.expiresAt };
}
