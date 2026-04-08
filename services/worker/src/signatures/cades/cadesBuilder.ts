/**
 * CAdES Builder — CMS Advanced Electronic Signatures (DER-encoded)
 *
 * Produces CAdES-B-B through CAdES-B-LTA signatures per ETSI EN 319 122-1/2
 * using proper ASN.1 DER encoding via pkijs.
 *
 * The CMS SignedData structure follows RFC 5652 with CAdES-specific
 * signed and unsigned attributes per ETSI baselines.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

// @ts-ignore — asn1js has no compatible type declarations
import * as asn1js from 'asn1js';
// @ts-ignore — pkijs has no compatible type declarations
import * as pkijs from 'pkijs';
// @ts-ignore — pvtsutils has no compatible type declarations
import * as pvtsutils from 'pvtsutils';
import type { SignatureLevel, LtvData } from '../types.js';
import { ETSI_PROFILE, OID } from '../constants.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface CadesSignatureParams {
  signatureValue: string;         // base64-encoded raw signature bytes
  signedAttributes: Record<string, unknown>;
  signerCertPem: string;
  chainPem: string[];
  level: SignatureLevel;
  signatureAlgorithm: string;
  timestampToken?: Buffer;        // DER-encoded TST for B-T+
  ltvData?: LtvData;
  archiveTimestamp?: Buffer;
}

export interface CadesSignatureResult {
  /** DER-encoded CMS SignedData (base64). */
  cmsSignedData: string;
  /** Raw DER bytes. */
  cmsSignedDataDer: Buffer;
  profile: string;
}

// ─── Builder ───────────────────────────────────────────────────────────

/**
 * Build a CAdES signature as a proper CMS SignedData DER structure.
 */
export function buildCadesSignature(params: CadesSignatureParams): CadesSignatureResult {
  const profile = getProfile(params.level);

  // Parse signer certificate
  const signerCertDer = pemToDer(params.signerCertPem);
  const signerCert = pkijs.Certificate.fromBER(signerCertDer);

  // Parse chain certificates
  const chainCerts = params.chainPem.map(pem => {
    const der = pemToDer(pem);
    return pkijs.Certificate.fromBER(der);
  });

  // Build SignedAttributes
  const signedAttrs = buildSignedAttributes(params, signerCert);

  // Build SignerInfo
  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({
      issuer: signerCert.issuer,
      serialNumber: signerCert.serialNumber,
    }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: OID.SHA256,
    }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: resolveSignatureOid(params.signatureAlgorithm),
    }),
    signature: new asn1js.OctetString({
      valueHex: pvtsutils.Convert.FromBase64(params.signatureValue),
    }),
    signedAttrs: signedAttrs,
  });

  // Add unsigned attributes for B-T+
  const unsignedAttrs = buildUnsignedAttributes(params);
  if (unsignedAttrs.length > 0) {
    signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1, // unsigned
      attributes: unsignedAttrs,
    });
  }

  // Build SignedData
  const cmsSignedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [
      new pkijs.AlgorithmIdentifier({ algorithmId: OID.SHA256 }),
    ],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID.DATA,
    }),
    certificates: [signerCert, ...chainCerts],
    signerInfos: [signerInfo],
  });

  // Wrap in ContentInfo
  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.SIGNED_DATA,
    content: cmsSignedData.toSchema(true),
  });

  // Encode to DER
  const derBuffer = contentInfo.toSchema().toBER(false);
  const derBytes = Buffer.from(derBuffer);

  return {
    cmsSignedData: derBytes.toString('base64'),
    cmsSignedDataDer: derBytes,
    profile,
  };
}

// ─── Signed Attributes ─────────────────────────────────────────────────

function buildSignedAttributes(
  params: CadesSignatureParams,
  signerCert: pkijs.Certificate,
): pkijs.SignedAndUnsignedAttributes {
  const attrs: pkijs.Attribute[] = [];

  // Content-type attribute
  attrs.push(new pkijs.Attribute({
    type: OID.CONTENT_TYPE,
    values: [new asn1js.ObjectIdentifier({ value: OID.DATA })],
  }));

  // Message-digest attribute
  const digestHex = String(params.signedAttributes.messageDigest || '').replace('sha256:', '');
  if (digestHex) {
    attrs.push(new pkijs.Attribute({
      type: OID.MESSAGE_DIGEST,
      values: [new asn1js.OctetString({
        valueHex: pvtsutils.Convert.FromHex(digestHex),
      })],
    }));
  }

  // Signing-time attribute
  const signingTime = String(params.signedAttributes.signingTime || new Date().toISOString());
  attrs.push(new pkijs.Attribute({
    type: OID.SIGNING_TIME,
    values: [new asn1js.UTCTime({ valueDate: new Date(signingTime) })],
  }));

  // Signing-certificate-v2 attribute (ETSI EN 319 122-1 requirement)
  const certHash = params.signedAttributes.signingCertificateV2 as any;
  if (certHash?.certHash) {
    const hashValue = pvtsutils.Convert.FromHex(String(certHash.certHash));
    // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm, certHash, issuerSerial }
    const essCertId = new asn1js.Sequence({
      value: [
        // hashAlgorithm (AlgorithmIdentifier — SHA-256 is default, can be omitted)
        // certHash
        new asn1js.OctetString({ valueHex: hashValue }),
      ],
    });

    attrs.push(new pkijs.Attribute({
      type: OID.SIGNING_CERTIFICATE_V2,
      values: [new asn1js.Sequence({ value: [
        new asn1js.Sequence({ value: [essCertId] }), // certs
      ] })],
    }));
  }

  return new pkijs.SignedAndUnsignedAttributes({
    type: 0, // signed
    attributes: attrs,
  });
}

// ─── Unsigned Attributes ───────────────────────────────────────────────

function buildUnsignedAttributes(params: CadesSignatureParams): pkijs.Attribute[] {
  const attrs: pkijs.Attribute[] = [];

  // B-T: Signature timestamp
  if (params.timestampToken && params.level !== 'B-B') {
    attrs.push(new pkijs.Attribute({
      type: OID.SIGNATURE_TIMESTAMP,
      values: [asn1js.fromBER(params.timestampToken).result],
    }));
  }

  // B-LT: Certificate and revocation values
  if (params.ltvData && (params.level === 'B-LT' || params.level === 'B-LTA')) {
    // certificate-values (OID 1.2.840.113549.1.9.16.2.23)
    const certValues = params.ltvData.certificates.map(pem => {
      const der = pemToDer(pem);
      return new asn1js.OctetString({ valueHex: der });
    });
    if (certValues.length > 0) {
      attrs.push(new pkijs.Attribute({
        type: '1.2.840.113549.1.9.16.2.23', // id-smime-aa-ets-certValues
        values: [new asn1js.Sequence({ value: certValues })],
      }));
    }

    // revocation-values (OID 1.2.840.113549.1.9.16.2.24)
    const revValues: asn1js.BaseBlock[] = [];
    for (const ocsp of params.ltvData.ocspResponses) {
      if (ocsp.raw.length > 0) {
        revValues.push(new asn1js.OctetString({ valueHex: ocsp.raw }));
      }
    }
    for (const crl of params.ltvData.crls) {
      if (crl.raw.length > 0) {
        revValues.push(new asn1js.OctetString({ valueHex: crl.raw }));
      }
    }
    if (revValues.length > 0) {
      attrs.push(new pkijs.Attribute({
        type: '1.2.840.113549.1.9.16.2.24', // id-smime-aa-ets-revocationValues
        values: [new asn1js.Sequence({ value: revValues })],
      }));
    }
  }

  // B-LTA: Archive timestamp
  if (params.archiveTimestamp && params.level === 'B-LTA') {
    attrs.push(new pkijs.Attribute({
      type: '1.2.840.113549.1.9.16.2.48', // id-smime-aa-ets-archiveTimestampV3
      values: [asn1js.fromBER(params.archiveTimestamp).result],
    }));
  }

  return attrs;
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

function resolveSignatureOid(alg: string): string {
  if (alg.includes('RSA') || alg.includes('rsa')) return OID.SHA256_WITH_RSA;
  if (alg.includes('ECDSA') || alg.includes('ecdsa')) return OID.ECDSA_WITH_SHA256;
  return OID.SHA256_WITH_RSA;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s/g, '');
  return pvtsutils.Convert.FromBase64(b64);
}
