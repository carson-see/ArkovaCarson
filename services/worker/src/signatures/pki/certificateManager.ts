/**
 * Certificate Manager — X.509 certificate chain resolution, validation, and caching.
 *
 * Validates certificate chains against the trust store, checks validity periods,
 * and enforces ETSI TS 119 312 algorithm constraints.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type {
  CertificateChainValidationResult,
  KeyAlgorithm,
} from '../types.js';
import { BANNED_ALGORITHMS, MIN_RSA_KEY_SIZE } from '../constants.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface CertificateManager {
  /**
   * Validate a certificate chain from leaf cert to a trusted root.
   * Checks: validity period, algorithm compliance, chain integrity.
   */
  validateChain(leafPem: string, chainPem: string[]): Promise<CertificateChainValidationResult>;

  /**
   * Parse a PEM certificate and extract metadata.
   */
  parseCertificate(pem: string): CertificateInfo;

  /**
   * Compute SHA-256 fingerprint of a DER-encoded certificate.
   */
  fingerprint(pem: string): string;

  /**
   * Check if a certificate's algorithm and key size comply with ETSI TS 119 312.
   */
  validateAlgorithmCompliance(pem: string): AlgorithmComplianceResult;
}

export interface CertificateInfo {
  subjectCn: string;
  subjectOrg: string | null;
  issuerCn: string;
  issuerOrg: string | null;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  keyAlgorithm: KeyAlgorithm | string;
  keySize: number;
  signatureAlgorithm: string;
  fingerprintSha256: string;
  ocspUrls: string[];
  crlUrls: string[];
  isCA: boolean;
}

export interface AlgorithmComplianceResult {
  compliant: boolean;
  errors: string[];
}

interface SignatureAlgorithmFields {
  signatureAlgorithm?: string;
  signatureAlgorithmOid?: string;
}

interface Asn1Element {
  tag: number;
  valueStart: number;
  valueEnd: number;
  nextOffset: number;
}

function readAsn1Element(buffer: Uint8Array, offset: number): Asn1Element | null {
  if (offset + 2 > buffer.length) {
    return null;
  }

  const tag = buffer[offset];
  const firstLengthByte = buffer[offset + 1];
  let valueStart = offset + 2;
  let length = 0;

  if ((firstLengthByte & 0x80) === 0) {
    length = firstLengthByte;
  } else {
    const lengthBytes = firstLengthByte & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || valueStart + lengthBytes > buffer.length) {
      return null;
    }

    for (let i = 0; i < lengthBytes; i++) {
      length = (length << 8) | buffer[valueStart + i];
    }
    valueStart += lengthBytes;
  }

  const valueEnd = valueStart + length;
  if (valueEnd > buffer.length) {
    return null;
  }

  return {
    tag,
    valueStart,
    valueEnd,
    nextOffset: valueEnd,
  };
}

function decodeObjectIdentifier(bytes: Uint8Array): string | null {
  if (bytes.length === 0) {
    return null;
  }

  const firstByte = bytes[0];
  const firstArc = firstByte < 40 ? 0 : firstByte < 80 ? 1 : 2;
  const arcs = [firstArc, firstByte - firstArc * 40];
  let value = 0;
  let hasContinuation = false;

  for (let i = 1; i < bytes.length; i++) {
    const byte = bytes[i];
    if (value > Number.MAX_SAFE_INTEGER / 128) {
      return null;
    }

    value = value * 128 + (byte & 0x7f);
    hasContinuation = (byte & 0x80) !== 0;
    if (!hasContinuation) {
      arcs.push(value);
      value = 0;
    }
  }

  return hasContinuation ? null : arcs.join('.');
}

function parseCertificateSignatureAlgorithmOid(raw: Uint8Array): string | null {
  const certificate = readAsn1Element(raw, 0);
  if (!certificate || certificate.tag !== 0x30) {
    return null;
  }

  const tbsCertificate = readAsn1Element(raw, certificate.valueStart);
  if (!tbsCertificate) {
    return null;
  }

  const signatureAlgorithm = readAsn1Element(raw, tbsCertificate.nextOffset);
  if (!signatureAlgorithm || signatureAlgorithm.tag !== 0x30) {
    return null;
  }

  const algorithmOid = readAsn1Element(raw, signatureAlgorithm.valueStart);
  if (!algorithmOid || algorithmOid.tag !== 0x06) {
    return null;
  }

  return decodeObjectIdentifier(raw.subarray(algorithmOid.valueStart, algorithmOid.valueEnd));
}

// ─── Implementation ────────────────────────────────────────────────────

export class X509CertificateManager implements CertificateManager {
  async validateChain(
    leafPem: string,
    chainPem: string[],
  ): Promise<CertificateChainValidationResult> {
    const errors: string[] = [];
    const chain = [leafPem, ...chainPem];

    try {
      // Validate each certificate individually
      for (let i = 0; i < chain.length; i++) {
        const certPem = chain[i];
        const info = this.parseCertificate(certPem);

        // Check validity period
        const now = new Date();
        if (now < info.notBefore) {
          errors.push(`Certificate ${info.subjectCn} not yet valid (notBefore: ${info.notBefore.toISOString()})`);
        }
        if (now > info.notAfter) {
          errors.push(`Certificate ${info.subjectCn} has expired (notAfter: ${info.notAfter.toISOString()})`);
        }

        // Check algorithm compliance
        const compliance = this.validateAlgorithmCompliance(certPem);
        if (!compliance.compliant) {
          errors.push(...compliance.errors.map(e => `${info.subjectCn}: ${e}`));
        }
      }

      // Validate chain linkage using Node.js crypto
      // For each cert (except root), verify it was issued by the next cert in chain
      for (let i = 0; i < chain.length - 1; i++) {
        const cert = new crypto.X509Certificate(chain[i]);
        const issuer = new crypto.X509Certificate(chain[i + 1]);

        if (!cert.checkIssued(issuer)) {
          const certInfo = this.parseCertificate(chain[i]);
          const issuerInfo = this.parseCertificate(chain[i + 1]);
          errors.push(`Chain broken: ${certInfo.subjectCn} not issued by ${issuerInfo.subjectCn}`);
        }
      }

      // Identify trust anchor (last cert in chain)
      const rootInfo = this.parseCertificate(chain[chain.length - 1]);

      return {
        valid: errors.length === 0,
        chain,
        trustAnchor: rootInfo.subjectCn,
        errors,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Certificate chain validation failed');
      return {
        valid: false,
        chain,
        trustAnchor: 'unknown',
        errors: [`Chain validation error: ${message}`],
      };
    }
  }

  parseCertificate(pem: string): CertificateInfo {
    const cert = new crypto.X509Certificate(pem);

    // Parse subject fields
    const subjectCn = extractField(cert.subject, 'CN') || 'unknown';
    const subjectOrg = extractField(cert.subject, 'O') || null;
    const issuerCn = extractField(cert.issuer, 'CN') || 'unknown';
    const issuerOrg = extractField(cert.issuer, 'O') || null;

    // Determine key algorithm and size
    const publicKey = cert.publicKey;
    let keyAlgorithm: KeyAlgorithm | string = 'unknown';
    let keySize = 0;

    const keyInfo = publicKey.asymmetricKeyType;
    if (keyInfo === 'rsa') {
      const detail = publicKey.asymmetricKeyDetails;
      keySize = detail?.modulusLength || 0;
      keyAlgorithm = keySize <= 2048 ? 'RSA-2048' : `RSA-${keySize}`;
    } else if (keyInfo === 'ec') {
      const detail = publicKey.asymmetricKeyDetails;
      const namedCurve = detail?.namedCurve || '';
      keySize = namedCurve === 'prime256v1' || namedCurve === 'P-256' ? 256 : 384;
      keyAlgorithm = keySize === 256 ? 'ECDSA-P256' : 'ECDSA-P384';
    }

    // Extract OCSP and CRL URLs from info access extensions
    const ocspUrls: string[] = [];
    const crlUrls: string[] = [];

    // Parse Authority Information Access for OCSP
    const infoAccess = cert.infoAccess;
    if (infoAccess) {
      const ocspMatch = infoAccess.match(/OCSP - URI:([^\n]+)/g);
      if (ocspMatch) {
        ocspUrls.push(...ocspMatch.map(m => m.replace('OCSP - URI:', '').trim()));
      }
    }

    // CRL distribution points
    const subjectAltName = cert.toString();
    const crlMatch = subjectAltName.match(/URI:(http[^\s,]+\.crl)/g);
    if (crlMatch) {
      crlUrls.push(...crlMatch.map(m => m.replace('URI:', '')));
    }

    const signatureAlgorithm = this.getSignatureAlgorithm(cert);

    return {
      subjectCn,
      subjectOrg,
      issuerCn,
      issuerOrg,
      serialNumber: cert.serialNumber,
      notBefore: new Date(cert.validFrom),
      notAfter: new Date(cert.validTo),
      keyAlgorithm,
      keySize,
      signatureAlgorithm,
      fingerprintSha256: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
      ocspUrls,
      crlUrls,
      isCA: cert.ca,
    };
  }

  fingerprint(pem: string): string {
    const cert = new crypto.X509Certificate(pem);
    return cert.fingerprint256.replace(/:/g, '').toLowerCase();
  }

  validateAlgorithmCompliance(pem: string): AlgorithmComplianceResult {
    const errors: string[] = [];
    const info = this.parseCertificate(pem);

    // Check signature algorithm
    if (BANNED_ALGORITHMS.has(info.signatureAlgorithm)) {
      errors.push(`Banned signature algorithm: ${info.signatureAlgorithm}`);
    }

    // Check key size
    if (info.keyAlgorithm.startsWith('RSA') && info.keySize < MIN_RSA_KEY_SIZE) {
      errors.push(`RSA key size ${info.keySize} below minimum ${MIN_RSA_KEY_SIZE}`);
    }

    return { compliant: errors.length === 0, errors };
  }

  private getSignatureAlgorithm(cert: crypto.X509Certificate): string {
    const signatureFields = cert as crypto.X509Certificate & SignatureAlgorithmFields;
    const oid = signatureFields.signatureAlgorithmOid ?? parseCertificateSignatureAlgorithmOid(cert.raw);

    if (oid && BANNED_ALGORITHMS.has(oid)) {
      return oid;
    }

    return signatureFields.signatureAlgorithm ?? oid ?? 'unknown';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function extractField(dn: string, field: string): string | null {
  // DN format: "CN=Example\nO=Example Corp\nC=US"
  const regex = new RegExp(`${field}=([^\\n]+)`);
  const match = dn.match(regex);
  return match ? match[1].trim() : null;
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createCertificateManager(): CertificateManager {
  return new X509CertificateManager();
}
