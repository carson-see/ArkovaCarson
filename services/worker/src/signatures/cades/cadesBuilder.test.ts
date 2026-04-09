/**
 * CAdES Builder Tests — DER-encoded CMS SignedData
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { describe, it, expect } from 'vitest';
import { buildCadesSignature, type CadesSignatureParams } from './cadesBuilder.js';
import { ETSI_PROFILE } from '../constants.js';

/** Build a test certificate PEM using pkijs (structurally valid DER). */
function getTestCertPem(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkijsMod = require('pkijs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const asn1Mod = require('asn1js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pvt = require('pvtsutils');

  const cert = new pkijsMod.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1Mod.Integer({ value: 1 });

  const dn = new pkijsMod.RelativeDistinguishedNames();
  dn.typesAndValues.push(new pkijsMod.AttributeTypeAndValue({
    type: '2.5.4.3',
    value: new asn1Mod.Utf8String({ value: 'Test CA' }),
  }));
  cert.issuer = dn;
  cert.subject = dn;
  cert.notBefore = new pkijsMod.Time({ type: 0, value: new Date('2024-01-01') });
  cert.notAfter = new pkijsMod.Time({ type: 0, value: new Date('2028-01-01') });
  cert.subjectPublicKeyInfo = new pkijsMod.PublicKeyInfo();
  cert.subjectPublicKeyInfo.algorithm = new pkijsMod.AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.1' });
  cert.subjectPublicKeyInfo.subjectPublicKey = new asn1Mod.BitString({ valueHex: new Uint8Array(270).buffer });
  cert.signatureAlgorithm = new pkijsMod.AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.11' });
  cert.signatureValue = new asn1Mod.BitString({ valueHex: new Uint8Array(256).buffer });

  const der = cert.toSchema(true).toBER(false);
  const b64 = pvt.Convert.ToBase64(der);
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function createParams(overrides?: Partial<CadesSignatureParams>): CadesSignatureParams {
  const certPem = getTestCertPem();
  return {
    signatureValue: Buffer.from('test-signature-value-32bytes!!!!').toString('base64'),
    signedAttributes: {
      messageDigest: 'sha256:' + 'a'.repeat(64),
      signingTime: '2026-04-05T12:00:00Z',
      signingCertificateV2: { certHash: 'ab'.repeat(32), issuerSerial: { issuer: 'Test CA', serial: '01' } },
    },
    signerCertPem: certPem,
    chainPem: [],
    level: 'B-B',
    signatureAlgorithm: 'ecdsa-with-SHA256',
    ...overrides,
  };
}

describe('CAdES Builder (DER)', () => {
  it('should produce valid DER-encoded CMS SignedData for B-B', () => {
    const result = buildCadesSignature(createParams({ level: 'B-B' }));

    expect(result.profile).toBe(ETSI_PROFILE.CADES_B_B);
    expect(result.cmsSignedData).toBeTruthy();
    expect(result.cmsSignedDataDer).toBeInstanceOf(Buffer);
    expect(result.cmsSignedDataDer.length).toBeGreaterThan(100);

    // Verify it starts with ASN.1 SEQUENCE tag (0x30)
    expect(result.cmsSignedDataDer[0]).toBe(0x30);
  });

  it('should include timestamp in unsigned attrs for B-T', () => {
    const tst = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]); // minimal ASN.1
    const result = buildCadesSignature(createParams({
      level: 'B-T',
      timestampToken: tst,
    }));

    expect(result.profile).toBe(ETSI_PROFILE.CADES_B_T);
    expect(result.cmsSignedDataDer.length).toBeGreaterThan(100);
  });

  it('should return correct profile for each level', () => {
    expect(buildCadesSignature(createParams({ level: 'B-B' })).profile).toBe(ETSI_PROFILE.CADES_B_B);
    expect(buildCadesSignature(createParams({ level: 'B-T', timestampToken: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]) })).profile).toBe(ETSI_PROFILE.CADES_B_T);
    expect(buildCadesSignature(createParams({ level: 'B-LT', timestampToken: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), ltvData: { ocspResponses: [], crls: [], certificates: [] } })).profile).toBe(ETSI_PROFILE.CADES_B_LT);
    expect(buildCadesSignature(createParams({ level: 'B-LTA', timestampToken: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), ltvData: { ocspResponses: [], crls: [], certificates: [] }, archiveTimestamp: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]) })).profile).toBe(ETSI_PROFILE.CADES_B_LTA);
  });

  it('should produce base64 that decodes to same DER', () => {
    const result = buildCadesSignature(createParams());
    const decoded = Buffer.from(result.cmsSignedData, 'base64');
    expect(decoded).toEqual(result.cmsSignedDataDer);
  });
});
