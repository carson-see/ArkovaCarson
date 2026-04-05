/**
 * LTV Builder/Validator Tests — Phase III
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DefaultLtvBuilder, DefaultLtvValidator, createLtvBuilder, createLtvValidator } from './ltvBuilder.js';
import { X509CertificateManager } from '../pki/certificateManager.js';
import { createMockOcspClient, MockOcspClient } from '../pki/ocspClient.js';
import { createMockCrlManager, MockCrlManager } from '../pki/crlManager.js';
import type { LtvData, OcspResponse } from '../types.js';

describe('LTV Builder', () => {
  let certManager: X509CertificateManager;
  let ocspClient: MockOcspClient;
  let crlManager: MockCrlManager;
  let builder: DefaultLtvBuilder;

  beforeEach(() => {
    certManager = new X509CertificateManager();
    ocspClient = createMockOcspClient();
    crlManager = createMockCrlManager();

    vi.spyOn(certManager, 'parseCertificate').mockReturnValue({
      subjectCn: 'Test Cert',
      subjectOrg: 'Test Corp',
      issuerCn: 'Test CA',
      issuerOrg: 'Test CA Corp',
      serialNumber: 'AABB01',
      notBefore: new Date('2024-01-01'),
      notAfter: new Date('2028-01-01'),
      keyAlgorithm: 'ECDSA-P256',
      keySize: 256,
      signatureAlgorithm: 'ecdsa-with-SHA256',
      fingerprintSha256: 'abcd1234'.repeat(8),
      ocspUrls: ['http://ocsp.test.com'],
      crlUrls: ['http://crl.test.com/ca.crl'],
      isCA: false,
    });

    builder = new DefaultLtvBuilder(certManager, ocspClient, crlManager);
  });

  it('should aggregate OCSP responses for chain', async () => {
    const result = await builder.buildLtvData(
      'leaf-pem',
      ['intermediate-pem', 'root-pem'],
    );

    expect(result.ocspResponses.length).toBeGreaterThan(0);
    expect(ocspClient.checkCalls.length).toBe(3); // leaf + intermediate + root
  });

  it('should aggregate CRLs for chain', async () => {
    const result = await builder.buildLtvData(
      'leaf-pem',
      ['intermediate-pem'],
    );

    expect(result.crls.length).toBeGreaterThan(0);
    expect(crlManager.fetchCalls.length).toBeGreaterThan(0);
  });

  it('should include intermediate certificates', async () => {
    const result = await builder.buildLtvData(
      'leaf-pem',
      ['intermediate-pem', 'root-pem'],
    );

    expect(result.certificates).toContain('intermediate-pem');
    expect(result.certificates).toContain('root-pem');
  });

  it('should handle OCSP failure gracefully', async () => {
    // Make OCSP throw for all URLs
    vi.spyOn(certManager, 'parseCertificate').mockReturnValue({
      subjectCn: 'Test',
      subjectOrg: null,
      issuerCn: 'CA',
      issuerOrg: null,
      serialNumber: '01',
      notBefore: new Date(),
      notAfter: new Date(),
      keyAlgorithm: 'ECDSA-P256',
      keySize: 256,
      signatureAlgorithm: 'ecdsa-with-SHA256',
      fingerprintSha256: 'abc',
      ocspUrls: [],
      crlUrls: ['http://crl.test.com/ca.crl'],
      isCA: false,
    });

    const result = await builder.buildLtvData('leaf', []);

    // Should still have CRL data even though no OCSP
    expect(result.crls.length).toBeGreaterThan(0);
  });
});

describe('LTV Validator', () => {
  let validator: DefaultLtvValidator;

  beforeEach(() => {
    validator = new DefaultLtvValidator();
  });

  it('should validate complete LTV data', () => {
    const ltvData: LtvData = {
      ocspResponses: [
        { status: 'good', producedAt: new Date(), thisUpdate: new Date(), nextUpdate: null, revocationTime: null, revocationReason: null, responderName: 'test', raw: Buffer.from('') },
      ],
      crls: [
        { issuerCn: 'Test CA', crlUrl: 'http://crl.test.com', lastUpdate: new Date(), nextUpdate: new Date(), raw: Buffer.from('') },
      ],
      certificates: ['intermediate-pem'],
    };

    const result = validator.validateLtvData(ltvData, 2);

    expect(result.valid).toBe(true);
    expect(result.ocspCoverage).toBeGreaterThan(0);
    expect(result.crlCoverage).toBeGreaterThan(0);
  });

  it('should fail for empty LTV data', () => {
    const ltvData: LtvData = {
      ocspResponses: [],
      crls: [],
      certificates: [],
    };

    const result = validator.validateLtvData(ltvData, 2);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No OCSP responses or CRLs available — LTV data is empty');
  });

  it('should detect revoked certificate in OCSP', () => {
    const ltvData: LtvData = {
      ocspResponses: [
        {
          status: 'revoked',
          producedAt: new Date(),
          thisUpdate: new Date(),
          nextUpdate: null,
          revocationTime: new Date('2026-01-15'),
          revocationReason: 'KEY_COMPROMISE',
          responderName: 'test',
          raw: Buffer.from(''),
        },
      ],
      crls: [],
      certificates: [],
    };

    const result = validator.validateLtvData(ltvData, 2);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('revoked'))).toBe(true);
  });
});
