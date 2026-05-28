/**
 * SCRUM-2043 — Multi-key DocuSign Connect HMAC verification (SOC 2 CC6.1).
 *
 * DocuSign signs webhook payloads with ALL account-level HMAC keys
 * simultaneously, sending X-DocuSign-Signature-1 through -N. During key
 * rotation both old and new keys are active. This verifier accepts the
 * payload if ANY provided signature matches ANY provided key.
 */

import { verifyHmacSha256Base64 } from './hmac.js';

export function verifyDocusignConnectHmacMultiKey(args: {
  rawBody: Buffer | string;
  signatures: string[];
  keys: string[];
}): boolean {
  const validSigs = args.signatures.filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (validSigs.length === 0 || args.keys.length === 0) return false;

  for (const sig of validSigs) {
    for (const key of args.keys) {
      if (verifyHmacSha256Base64({ rawBody: args.rawBody, signature: sig, secret: key })) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extract all X-DocuSign-Signature-* headers from an Express request.
 * DocuSign sends -1, -2, ..., -N for each configured HMAC key.
 */
export function extractDocusignSignatures(
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const sigs: string[] = [];
  for (let i = 1; i <= 100; i++) {
    const val = headers[`x-docusign-signature-${i}`];
    if (!val) break;
    const s = Array.isArray(val) ? val[0] : val;
    if (s) sigs.push(s);
  }
  return sigs;
}
