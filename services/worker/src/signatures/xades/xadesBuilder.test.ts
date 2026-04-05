/**
 * XAdES Builder Tests — Phase III
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { describe, it, expect } from 'vitest';
import { buildXadesSignature, type XadesSignatureParams } from './xadesBuilder.js';
import { ETSI_PROFILE, XMLNS } from '../constants.js';

function createParams(overrides?: Partial<XadesSignatureParams>): XadesSignatureParams {
  return {
    signatureValue: 'dGVzdHNpZ25hdHVyZQ==',
    signedAttributes: {
      messageDigest: 'sha256:' + 'a'.repeat(64),
      signingTime: '2026-04-04T12:00:00Z',
      signingCertificateV2: { certHash: 'abcd1234', issuerSerial: { issuer: 'Test CA', serial: '01' } },
    },
    signerCertPem: '-----BEGIN CERTIFICATE-----\nTUlJ\n-----END CERTIFICATE-----',
    chainPem: ['-----BEGIN CERTIFICATE-----\nQ0E=\n-----END CERTIFICATE-----'],
    level: 'B-B',
    signatureAlgorithm: 'ecdsa-with-SHA256',
    ...overrides,
  };
}

describe('XAdES Builder', () => {
  it('should produce valid XAdES-B-B XML', () => {
    const result = buildXadesSignature(createParams({ level: 'B-B' }));

    expect(result.profile).toBe(ETSI_PROFILE.XADES_B_B);
    expect(result.xml).toContain(`xmlns:ds="${XMLNS.DS}"`);
    expect(result.xml).toContain(`xmlns:xades="${XMLNS.XADES}"`);
    expect(result.xml).toContain('<ds:SignatureValue>');
    expect(result.xml).toContain('<xades:SignedProperties');
    expect(result.xml).toContain('<xades:SigningTime>2026-04-04T12:00:00Z</xades:SigningTime>');
    expect(result.xml).toContain('<xades:SigningCertificateV2>');
    // B-B should NOT have UnsignedProperties
    expect(result.xml).not.toContain('<xades:UnsignedProperties>');
  });

  it('should produce XAdES-B-T with SignatureTimeStamp', () => {
    const tst = Buffer.from('mock-timestamp-token');
    const result = buildXadesSignature(createParams({ level: 'B-T', timestampToken: tst }));

    expect(result.profile).toBe(ETSI_PROFILE.XADES_B_T);
    expect(result.xml).toContain('<xades:SignatureTimeStamp>');
    expect(result.xml).toContain('<xades:EncapsulatedTimeStamp>');
    expect(result.xml).toContain(tst.toString('base64'));
  });

  it('should produce XAdES-B-LT with CertificateValues and RevocationValues', () => {
    const result = buildXadesSignature(createParams({
      level: 'B-LT',
      timestampToken: Buffer.from('tst'),
      ltvData: {
        ocspResponses: [{ status: 'good', producedAt: new Date(), thisUpdate: new Date(), nextUpdate: null, revocationTime: null, revocationReason: null, responderName: 'test', raw: Buffer.from('ocsp-data') }],
        crls: [{ issuerCn: 'CA', crlUrl: 'http://crl.test.com', lastUpdate: new Date(), nextUpdate: new Date(), raw: Buffer.from('crl-data') }],
        certificates: ['-----BEGIN CERTIFICATE-----\nSU5U\n-----END CERTIFICATE-----'],
      },
    }));

    expect(result.profile).toBe(ETSI_PROFILE.XADES_B_LT);
    expect(result.xml).toContain('<xades:CertificateValues>');
    expect(result.xml).toContain('<xades:RevocationValues>');
    expect(result.xml).toContain('<xades:OCSPValues>');
    expect(result.xml).toContain('<xades:CRLValues>');
  });

  it('should produce XAdES-B-LTA with ArchiveTimeStamp', () => {
    const archiveTst = Buffer.from('archive-timestamp');
    const result = buildXadesSignature(createParams({
      level: 'B-LTA',
      timestampToken: Buffer.from('tst'),
      ltvData: {
        ocspResponses: [{ status: 'good', producedAt: new Date(), thisUpdate: new Date(), nextUpdate: null, revocationTime: null, revocationReason: null, responderName: 'test', raw: Buffer.from('ocsp') }],
        crls: [],
        certificates: [],
      },
      archiveTimestamp: archiveTst,
    }));

    expect(result.profile).toBe(ETSI_PROFILE.XADES_B_LTA);
    expect(result.xml).toContain('ArchiveTimeStamp');
    expect(result.xml).toContain(archiveTst.toString('base64'));
    expect(result.xml).toContain(XMLNS.XADES141);
  });

  it('should use correct algorithm URI for ECDSA', () => {
    const result = buildXadesSignature(createParams({ signatureAlgorithm: 'ecdsa-with-SHA256' }));
    expect(result.xml).toContain('ecdsa-sha256');
  });

  it('should use correct algorithm URI for RSA', () => {
    const result = buildXadesSignature(createParams({ signatureAlgorithm: 'sha256WithRSAEncryption' }));
    expect(result.xml).toContain('rsa-sha256');
  });

  it('should strip PEM headers from certificate data', () => {
    const result = buildXadesSignature(createParams());
    expect(result.xml).not.toContain('-----BEGIN CERTIFICATE-----');
    expect(result.xml).not.toContain('-----END CERTIFICATE-----');
    expect(result.xml).toContain('<ds:X509Certificate>');
  });
});
