/**
 * XAdES Builder — XML Advanced Electronic Signatures
 *
 * Produces XAdES-B-B through XAdES-B-LTA signatures per ETSI EN 319 132-1/2.
 * XAdES signatures wrap XML content with SignedProperties containing
 * signer certificate reference, signing time, and data object format.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import type { SignatureLevel, LtvData } from '../types.js';
import type { TimestampToken } from '../types.js';
import { XMLNS, ETSI_PROFILE } from '../constants.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface XadesSignatureParams {
  signatureValue: string;         // base64-encoded cryptographic signature
  signedAttributes: Record<string, unknown>;
  signerCertPem: string;
  chainPem: string[];
  level: SignatureLevel;
  signatureAlgorithm: string;
  timestampToken?: Buffer;        // DER-encoded TST for B-T+
  ltvData?: LtvData;              // for B-LT+
  archiveTimestamp?: Buffer;      // DER-encoded archive TST for B-LTA
}

export interface XadesSignatureResult {
  xml: string;                    // complete XAdES signature XML
  profile: string;                // ETSI profile URI
}

// ─── Builder ───────────────────────────────────────────────────────────

/**
 * Build an XAdES signature XML structure.
 *
 * The output follows the ETSI EN 319 132-1 schema:
 * - ds:Signature containing ds:SignedInfo, ds:SignatureValue, ds:KeyInfo
 * - xades:QualifyingProperties containing SignedProperties
 * - For B-T+: xades:UnsignedProperties with SignatureTimeStamp
 * - For B-LT+: xades:UnsignedProperties with CertificateValues + RevocationValues
 * - For B-LTA: xades:UnsignedProperties with ArchiveTimeStamp
 */
export function buildXadesSignature(params: XadesSignatureParams): XadesSignatureResult {
  const profile = getProfile(params.level);

  // Build SignedProperties
  const signedProps = buildSignedProperties(params);

  // Build UnsignedProperties (if B-T or above)
  const unsignedProps = buildUnsignedProperties(params);

  // Build complete XAdES XML
  const xml = [
    `<ds:Signature xmlns:ds="${XMLNS.DS}" xmlns:xades="${XMLNS.XADES}" Id="Signature-1">`,
    '  <ds:SignedInfo>',
    '    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>',
    `    <ds:SignatureMethod Algorithm="${algorithmUri(params.signatureAlgorithm)}"/>`,
    '    <ds:Reference URI="#SignedProperties-1" Type="http://uri.etsi.org/01903#SignedProperties">',
    '      <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
    `      <ds:DigestValue>${params.signedAttributes.messageDigest || ''}</ds:DigestValue>`,
    '    </ds:Reference>',
    '  </ds:SignedInfo>',
    `  <ds:SignatureValue>${params.signatureValue}</ds:SignatureValue>`,
    '  <ds:KeyInfo>',
    '    <ds:X509Data>',
    `      <ds:X509Certificate>${pemToBase64(params.signerCertPem)}</ds:X509Certificate>`,
    '    </ds:X509Data>',
    '  </ds:KeyInfo>',
    '  <ds:Object>',
    `    <xades:QualifyingProperties Target="#Signature-1">`,
    signedProps,
    unsignedProps,
    '    </xades:QualifyingProperties>',
    '  </ds:Object>',
    '</ds:Signature>',
  ].join('\n');

  return { xml, profile };
}

// ─── Internal Builders ─────────────────────────────────────────────────

function buildSignedProperties(params: XadesSignatureParams): string {
  const attrs = params.signedAttributes;
  const signingTime = attrs.signingTime as string || new Date().toISOString();

  return [
    '      <xades:SignedProperties Id="SignedProperties-1">',
    '        <xades:SignedSignatureProperties>',
    `          <xades:SigningTime>${signingTime}</xades:SigningTime>`,
    '          <xades:SigningCertificateV2>',
    '            <xades:Cert>',
    '              <xades:CertDigest>',
    '                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
    `                <ds:DigestValue>${(attrs.signingCertificateV2 as any)?.certHash || ''}</ds:DigestValue>`,
    '              </xades:CertDigest>',
    '            </xades:Cert>',
    '          </xades:SigningCertificateV2>',
    '        </xades:SignedSignatureProperties>',
    '      </xades:SignedProperties>',
  ].join('\n');
}

function buildUnsignedProperties(params: XadesSignatureParams): string {
  if (params.level === 'B-B') return '';

  const parts: string[] = ['      <xades:UnsignedProperties>'];

  // B-T: SignatureTimeStamp
  if (params.timestampToken) {
    parts.push(
      '        <xades:UnsignedSignatureProperties>',
      '          <xades:SignatureTimeStamp>',
      `            <xades:EncapsulatedTimeStamp>${params.timestampToken.toString('base64')}</xades:EncapsulatedTimeStamp>`,
      '          </xades:SignatureTimeStamp>',
    );
  }

  // B-LT: CertificateValues + RevocationValues
  if (params.ltvData && (params.level === 'B-LT' || params.level === 'B-LTA')) {
    // Certificate values
    parts.push('          <xades:CertificateValues>');
    for (const certPem of params.ltvData.certificates) {
      parts.push(
        '            <xades:EncapsulatedX509Certificate>',
        `              ${pemToBase64(certPem)}`,
        '            </xades:EncapsulatedX509Certificate>',
      );
    }
    parts.push('          </xades:CertificateValues>');

    // Revocation values (OCSP + CRL)
    parts.push('          <xades:RevocationValues>');
    for (const ocsp of params.ltvData.ocspResponses) {
      parts.push(
        '            <xades:OCSPValues>',
        `              <xades:EncapsulatedOCSPValue>${ocsp.raw.toString('base64')}</xades:EncapsulatedOCSPValue>`,
        '            </xades:OCSPValues>',
      );
    }
    for (const crl of params.ltvData.crls) {
      parts.push(
        '            <xades:CRLValues>',
        `              <xades:EncapsulatedCRLValue>${crl.raw.toString('base64')}</xades:EncapsulatedCRLValue>`,
        '            </xades:CRLValues>',
      );
    }
    parts.push('          </xades:RevocationValues>');
  }

  // B-LTA: ArchiveTimeStamp
  if (params.archiveTimestamp && params.level === 'B-LTA') {
    parts.push(
      `          <xades141:ArchiveTimeStamp xmlns:xades141="${XMLNS.XADES141}">`,
      `            <xades:EncapsulatedTimeStamp>${params.archiveTimestamp.toString('base64')}</xades:EncapsulatedTimeStamp>`,
      '          </xades141:ArchiveTimeStamp>',
    );
  }

  if (params.timestampToken) {
    parts.push('        </xades:UnsignedSignatureProperties>');
  }

  parts.push('      </xades:UnsignedProperties>');
  return parts.join('\n');
}

// ─── Helpers ───────────────────────────────────────────────────────────

function getProfile(level: SignatureLevel): string {
  switch (level) {
    case 'B-B': return ETSI_PROFILE.XADES_B_B;
    case 'B-T': return ETSI_PROFILE.XADES_B_T;
    case 'B-LT': return ETSI_PROFILE.XADES_B_LT;
    case 'B-LTA': return ETSI_PROFILE.XADES_B_LTA;
  }
}

function algorithmUri(alg: string): string {
  if (alg.includes('RSA')) return 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  if (alg.includes('ECDSA') || alg.includes('ecdsa')) return 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';
  return 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
}

function pemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
}
