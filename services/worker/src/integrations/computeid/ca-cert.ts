/**
 * ComputeID CA pin.
 *
 * The CA is PINNED from configuration (`COMPUTEID_CA_CERT_PEM`, Secret
 * Manager), never fetched from `https://api.aicomputeid.com/v1/ca/cert` at
 * runtime: fetching would reintroduce the partner-uptime dependency the
 * offline admission path exists to remove, and would trust-on-first-use
 * whatever the endpoint served. Rotation is the partner's promised 30-day
 * notice → a secret update → redeploy.
 *
 * Accepts either an X.509 certificate PEM (production — validity window and
 * `CA:TRUE` are enforced) or a bare SPKI public-key PEM (tests / staging,
 * where the signing key is one we hold). `key_id` is derived exactly the way
 * ComputeID publishes it: `sha256(SPKI PEM text)[:16]` — pinned by test
 * against their live value `ebb276c2f18ed34f`.
 *
 * Pure `node:crypto`; no logger, no config import (config.ts imports this).
 */
import { createHash, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';

export type PinnedCaKind = 'certificate' | 'public-key';

export interface PinnedCa {
  kind: PinnedCaKind;
  publicKey: KeyObject;
  /** 16 hex chars — matches ComputeID's `key_id`. */
  keyId: string;
  subject: string;
  notBefore: Date | null;
  notAfter: Date | null;
}

export function deriveKeyId(publicKey: KeyObject): string {
  const spkiPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  return createHash('sha256').update(spkiPem, 'utf8').digest('hex').slice(0, 16);
}

function assertRsa(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`ComputeID CA pin: key is not RSA (got ${key.asymmetricKeyType ?? 'unknown'})`);
  }
}

export function loadPinnedCa(pem: string, now: Date = new Date()): PinnedCa {
  const trimmed = (pem ?? '').trim();
  if (!trimmed) throw new Error('ComputeID CA pin: empty');

  if (trimmed.includes('-----BEGIN CERTIFICATE-----')) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(trimmed);
    } catch {
      throw new Error('ComputeID CA pin: unparseable certificate PEM');
    }
    const publicKey = cert.publicKey;
    assertRsa(publicKey);
    const notBefore = new Date(cert.validFrom);
    const notAfter = new Date(cert.validTo);
    if (now.getTime() < notBefore.getTime()) {
      throw new Error(`ComputeID CA pin: certificate not yet valid (validFrom=${cert.validFrom})`);
    }
    if (now.getTime() > notAfter.getTime()) {
      throw new Error(`ComputeID CA pin: certificate expired (validTo=${cert.validTo})`);
    }
    if (!cert.ca) throw new Error('ComputeID CA pin: certificate is not a CA');
    return {
      kind: 'certificate',
      publicKey,
      keyId: deriveKeyId(publicKey),
      subject: cert.subject.replaceAll('\n', ', '),
      notBefore,
      notAfter,
    };
  }

  if (trimmed.includes('-----BEGIN PUBLIC KEY-----')) {
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: trimmed, format: 'pem' });
    } catch {
      throw new Error('ComputeID CA pin: unparseable public-key PEM');
    }
    assertRsa(publicKey);
    return {
      kind: 'public-key',
      publicKey,
      keyId: deriveKeyId(publicKey),
      subject: 'raw-public-key',
      notBefore: null,
      notAfter: null,
    };
  }

  throw new Error('ComputeID CA pin: unrecognized PEM (expected CERTIFICATE or PUBLIC KEY)');
}
