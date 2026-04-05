/**
 * PAdES Builder — PDF Advanced Electronic Signatures
 *
 * Produces PAdES-B-B through PAdES-B-LTA signatures per ETSI EN 319 142-1/2.
 * PAdES signatures are embedded in PDF signature dictionaries. Since Arkova
 * never processes documents server-side (Constitution 1.6), the PAdES builder
 * produces the signature dictionary data that the client embeds into the PDF.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import type { SignatureLevel, LtvData } from '../types.js';
import { ETSI_PROFILE, OID } from '../constants.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface PadesSignatureParams {
  signatureValue: string;
  signedAttributes: Record<string, unknown>;
  signerCertPem: string;
  chainPem: string[];
  level: SignatureLevel;
  signatureAlgorithm: string;
  timestampToken?: Buffer;
  ltvData?: LtvData;
  archiveTimestamp?: Buffer;
  /** ByteRange of the PDF for signature embedding (provided by client). */
  byteRange?: [number, number, number, number];
}

export interface PadesSignatureResult {
  /**
   * Base64-encoded CMS SignedData for embedding in the PDF /Contents field.
   * The client is responsible for embedding this into the PDF signature dictionary.
   * Constitution 1.6: The PDF document never leaves the user's device.
   */
  cmsSignature: string;
  profile: string;
  /**
   * Document Security Store (DSS) data for B-LT and above.
   * Contains certificates, OCSP responses, and CRLs that the client
   * should embed in the PDF's DSS dictionary for LTV.
   */
  dss?: PadesDss;
}

export interface PadesDss {
  certs: string[];         // base64-encoded DER certificates
  ocsps: string[];         // base64-encoded DER OCSP responses
  crls: string[];          // base64-encoded DER CRLs
}

// ─── Builder ───────────────────────────────────────────────────────────

/**
 * Build a PAdES signature for PDF embedding.
 *
 * Returns the CMS SignedData (for /Contents) and DSS data (for LTV).
 * The client is responsible for:
 * 1. Creating the PDF signature dictionary with /ByteRange and /Contents
 * 2. Embedding the CMS signature in /Contents
 * 3. For B-LT+: Creating the DSS dictionary with certs, OCSPs, CRLs
 * 4. For B-LTA: Adding a document-level timestamp
 *
 * This preserves Constitution 1.6: the PDF never leaves the user's device.
 */
export function buildPadesSignature(params: PadesSignatureParams): PadesSignatureResult {
  const profile = getProfile(params.level);

  // Build CMS SignedData (same structure as CAdES, but with PAdES-specific attributes)
  const signedAttrs = {
    contentType: OID.DATA,
    messageDigest: params.signedAttributes.messageDigest,
    signingTime: params.signedAttributes.signingTime,
    signingCertificateV2: params.signedAttributes.signingCertificateV2,
  };

  const unsignedAttrs: Record<string, unknown> = {};

  if (params.timestampToken && params.level !== 'B-B') {
    unsignedAttrs.signatureTimeStamp = params.timestampToken.toString('base64');
  }

  const cmsStructure = {
    contentType: OID.SIGNED_DATA,
    content: {
      version: 1,
      digestAlgorithms: [{ algorithm: OID.SHA256 }],
      encapContentInfo: { eContentType: OID.DATA },
      certificates: [params.signerCertPem, ...params.chainPem],
      signerInfos: [{
        version: 1,
        signatureAlgorithm: params.signatureAlgorithm,
        signedAttrs,
        signature: params.signatureValue,
        unsignedAttrs: Object.keys(unsignedAttrs).length > 0 ? unsignedAttrs : undefined,
      }],
    },
  };

  const cmsSignature = Buffer.from(JSON.stringify(cmsStructure)).toString('base64');

  // Build DSS for B-LT and above
  let dss: PadesDss | undefined;
  if (params.ltvData && (params.level === 'B-LT' || params.level === 'B-LTA')) {
    dss = {
      certs: params.ltvData.certificates.map(c =>
        c.replace(/-----BEGIN CERTIFICATE-----/g, '')
         .replace(/-----END CERTIFICATE-----/g, '')
         .replace(/\s/g, ''),
      ),
      ocsps: params.ltvData.ocspResponses.map(o => o.raw.toString('base64')),
      crls: params.ltvData.crls.map(c => c.raw.toString('base64')),
    };
  }

  return { cmsSignature, profile, dss };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function getProfile(level: SignatureLevel): string {
  switch (level) {
    case 'B-B': return ETSI_PROFILE.PADES_B_B;
    case 'B-T': return ETSI_PROFILE.PADES_B_T;
    case 'B-LT': return ETSI_PROFILE.PADES_B_LT;
    case 'B-LTA': return ETSI_PROFILE.PADES_B_LTA;
  }
}
