/**
 * CAdES Builder — CMS Advanced Electronic Signatures
 *
 * Produces CAdES-B-B through CAdES-B-LTA signatures per ETSI EN 319 122-1/2.
 * CAdES uses CMS/PKCS#7 (RFC 5652) SignedData structure with additional
 * signed and unsigned attributes per the ETSI baseline profiles.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import type { SignatureLevel, LtvData } from '../types.js';
import { ETSI_PROFILE, OID } from '../constants.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface CadesSignatureParams {
  signatureValue: string;
  signedAttributes: Record<string, unknown>;
  signerCertPem: string;
  chainPem: string[];
  level: SignatureLevel;
  signatureAlgorithm: string;
  timestampToken?: Buffer;
  ltvData?: LtvData;
  archiveTimestamp?: Buffer;
}

export interface CadesSignatureResult {
  /** Base64-encoded CMS SignedData structure. */
  cmsSignedData: string;
  profile: string;
}

// ─── Builder ───────────────────────────────────────────────────────────

/**
 * Build a CAdES signature (CMS SignedData).
 *
 * The CMS structure contains:
 * - SignedData with embedded signer certificate and chain
 * - SignerInfo with signed attributes (content-type, message-digest, signing-time, signing-certificate-v2)
 * - For B-T+: unsigned attribute with SignatureTimeStamp
 * - For B-LT+: unsigned attributes with certificate-values and revocation-values
 * - For B-LTA: unsigned attribute with archive-time-stamp-v3
 *
 * Note: Full ASN.1 DER encoding requires asn1js/pkijs. This implementation
 * produces a JSON representation of the CMS structure for storage and
 * later serialization when those packages are integrated.
 */
export function buildCadesSignature(params: CadesSignatureParams): CadesSignatureResult {
  const profile = getProfile(params.level);

  const signedAttrs = {
    contentType: OID.DATA,
    messageDigest: params.signedAttributes.messageDigest,
    signingTime: params.signedAttributes.signingTime,
    signingCertificateV2: params.signedAttributes.signingCertificateV2,
  };

  const unsignedAttrs: Record<string, unknown> = {};

  // B-T: Signature timestamp
  if (params.timestampToken && params.level !== 'B-B') {
    unsignedAttrs.signatureTimeStamp = params.timestampToken.toString('base64');
  }

  // B-LT: Certificate and revocation values
  if (params.ltvData && (params.level === 'B-LT' || params.level === 'B-LTA')) {
    unsignedAttrs.certificateValues = params.ltvData.certificates.map(c =>
      c.replace(/-----BEGIN CERTIFICATE-----/g, '')
       .replace(/-----END CERTIFICATE-----/g, '')
       .replace(/\s/g, ''),
    );
    unsignedAttrs.revocationValues = {
      ocspResponses: params.ltvData.ocspResponses.map(o => o.raw.toString('base64')),
      crls: params.ltvData.crls.map(c => c.raw.toString('base64')),
    };
  }

  // B-LTA: Archive timestamp
  if (params.archiveTimestamp && params.level === 'B-LTA') {
    unsignedAttrs.archiveTimeStampV3 = params.archiveTimestamp.toString('base64');
  }

  // Build CMS SignedData structure (JSON representation)
  const cmsStructure = {
    contentType: OID.SIGNED_DATA,
    content: {
      version: 1,
      digestAlgorithms: [{ algorithm: OID.SHA256 }],
      encapContentInfo: {
        eContentType: OID.DATA,
      },
      certificates: [
        params.signerCertPem,
        ...params.chainPem,
      ],
      signerInfos: [{
        version: 1,
        signatureAlgorithm: params.signatureAlgorithm,
        signedAttrs,
        signature: params.signatureValue,
        unsignedAttrs: Object.keys(unsignedAttrs).length > 0 ? unsignedAttrs : undefined,
      }],
    },
  };

  const cmsSignedData = Buffer.from(JSON.stringify(cmsStructure)).toString('base64');

  return { cmsSignedData, profile };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function getProfile(level: SignatureLevel): string {
  switch (level) {
    case 'B-B': return ETSI_PROFILE.CADES_B_B;
    case 'B-T': return ETSI_PROFILE.CADES_B_T;
    case 'B-LT': return ETSI_PROFILE.CADES_B_LT;
    case 'B-LTA': return ETSI_PROFILE.CADES_B_LTA;
  }
}
