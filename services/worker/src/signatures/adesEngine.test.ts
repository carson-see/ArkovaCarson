/**
 * AdES Engine Tests — Phase III
 *
 * Tests the core signature engine orchestrator with mock dependencies.
 * Covers sign flow at all levels (B-B through B-LTA), verification,
 * error handling, and ETSI compliance checks.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DefaultAdesEngine } from './adesEngine.js';
import { createMockHsmBridge, MockHsmBridge } from './pki/hsmBridge.js';
import { X509CertificateManager } from './pki/certificateManager.js';
import { createMockOcspClient, MockOcspClient } from './pki/ocspClient.js';
import { createMockCrlManager, MockCrlManager } from './pki/crlManager.js';
import { createMockTrustStore, MockTrustStore } from './pki/trustStore.js';
import { MockRfc3161Client } from './timestamp/rfc3161Client.js';
import { createQtspProvider } from './timestamp/qtspProvider.js';
import { createLtvBuilder, createLtvValidator } from './ltv/ltvBuilder.js';
import type { SignRequest, SigningCertificate, SignatureRecord, TsaConfig } from './types.js';

// ─── Test Fixtures ─────────────────────────────────────────────────────

function createTestCertificate(overrides?: Partial<SigningCertificate>): SigningCertificate {
  return {
    id: 'cert-001',
    orgId: 'org-001',
    subjectCn: 'Test Signer',
    subjectOrg: 'Test Corp',
    issuerCn: 'Test CA',
    issuerOrg: 'Test CA Corp',
    serialNumber: 'AABB01',
    fingerprintSha256: 'abcd1234'.repeat(8),
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
    chainPem: ['-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----'],
    kmsProvider: 'aws_kms',
    kmsKeyId: 'arn:aws:kms:us-east-1:123:key/test',
    keyAlgorithm: 'ECDSA-P256',
    notBefore: new Date('2024-01-01'),
    notAfter: new Date('2028-01-01'),
    status: 'ACTIVE',
    trustLevel: 'ADVANCED',
    qtspName: null,
    euTrustedListEntry: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'user-001',
    metadata: {},
    ...overrides,
  };
}

function createTestSignRequest(overrides?: Partial<SignRequest>): SignRequest {
  return {
    anchorId: 'ARK-TEST-DOC-12345678',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    format: 'PAdES',
    level: 'B-B',
    signerCertificateId: 'cert-001',
    jurisdiction: 'EU',
    reason: 'Test signing',
    ...overrides,
  };
}

function createTestSignatureRecord(overrides?: Partial<SignatureRecord>): SignatureRecord {
  return {
    id: 'sig-001',
    publicId: 'ARK-TEST-SIG-AABB1234',
    orgId: 'org-001',
    anchorId: 'anchor-001',
    attestationId: null,
    format: 'PAdES',
    level: 'B-T',
    status: 'COMPLETE',
    jurisdiction: 'EU',
    documentFingerprint: 'sha256:' + 'a'.repeat(64),
    signerCertificateId: 'cert-001',
    signerName: 'Test Signer',
    signerOrg: 'Test Corp',
    signatureValue: 'base64sigvalue',
    signedAttributes: { messageDigest: 'sha256:aaaa', signingTime: '2026-01-01T00:00:00Z' },
    signatureAlgorithm: 'ecdsa-with-SHA256',
    timestampTokenId: 'tst-001',
    ltvDataEmbedded: false,
    archiveTimestampId: null,
    reason: 'Test',
    location: 'Berlin',
    contactInfo: null,
    createdAt: new Date(),
    signedAt: new Date(),
    completedAt: new Date(),
    revokedAt: null,
    revocationReason: null,
    createdBy: 'user-001',
    metadata: {},
    ...overrides,
  };
}

// ─── Test Setup ────────────────────────────────────────────────────────

describe('AdES Engine', () => {
  let hsm: MockHsmBridge;
  let certManager: X509CertificateManager;
  let ocspClient: MockOcspClient;
  let crlManager: MockCrlManager;
  let trustStore: MockTrustStore;
  let rfc3161Client: MockRfc3161Client;
  let engine: DefaultAdesEngine;

  const primaryTsa: TsaConfig = {
    name: 'DigiCert Test TSA',
    url: 'https://timestamp.digicert.com',
    qualified: true,
    timeoutMs: 5000,
  };

  beforeEach(() => {
    hsm = createMockHsmBridge();
    certManager = new X509CertificateManager();
    ocspClient = createMockOcspClient('good');
    crlManager = createMockCrlManager();
    trustStore = createMockTrustStore();
    rfc3161Client = new MockRfc3161Client();

    // Mock the certificate manager methods that need real X.509 certs
    vi.spyOn(certManager, 'validateChain').mockResolvedValue({
      valid: true,
      chain: ['leaf', 'root'],
      trustAnchor: 'Test Root CA',
      errors: [],
    });

    vi.spyOn(certManager, 'parseCertificate').mockReturnValue({
      subjectCn: 'Test Signer',
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

    const qtspProvider = createQtspProvider(rfc3161Client, primaryTsa);
    const ltvBuilder = createLtvBuilder(certManager, ocspClient, crlManager);
    const ltvValidator = createLtvValidator();

    engine = new DefaultAdesEngine(
      hsm,
      certManager,
      ocspClient,
      crlManager,
      trustStore,
      qtspProvider,
      ltvBuilder,
      ltvValidator,
    );
  });

  // ─── Sign Tests ────────────────────────────────────────────────────

  describe('sign', () => {
    it('should create a B-B signature (basic level)', async () => {
      const cert = createTestCertificate();
      const request = createTestSignRequest({ level: 'B-B' });

      const result = await engine.sign(request, cert, 'org-001', 'user-001');

      expect(result.signatureValue).toBeTruthy();
      expect(result.signedAttributes).toBeTruthy();
      expect(result.signatureAlgorithm).toBe('ecdsa-with-SHA256');
      expect(result.status).toBe('COMPLETE'); // B-B completes after signing
      expect(result.signedAt).toBeInstanceOf(Date);
      expect(hsm.signCalls).toHaveLength(1);
    });

    it('should create a B-T signature with timestamp', async () => {
      const cert = createTestCertificate();
      const request = createTestSignRequest({ level: 'B-T' });

      const result = await engine.sign(request, cert, 'org-001', 'user-001');

      expect(result.signatureValue).toBeTruthy();
      expect(result.status).toBe('TIMESTAMPED');
      expect(result.timestampTokenId).toBeTruthy();
      expect(rfc3161Client.calls).toHaveLength(1);
    });

    it('should create a B-LT signature with LTV data', async () => {
      const cert = createTestCertificate();
      const request = createTestSignRequest({ level: 'B-LT' });

      const result = await engine.sign(request, cert, 'org-001', 'user-001');

      expect(result.signatureValue).toBeTruthy();
      expect(result.ltvDataEmbedded).toBe(true);
      expect(result.status).toBe('LTV_EMBEDDED');
      expect(ocspClient.checkCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should create a B-LTA signature with archive timestamp', async () => {
      const cert = createTestCertificate();
      const request = createTestSignRequest({ level: 'B-LTA' });

      const result = await engine.sign(request, cert, 'org-001', 'user-001');

      expect(result.signatureValue).toBeTruthy();
      expect(result.ltvDataEmbedded).toBe(true);
      expect(result.archiveTimestampId).toBeTruthy();
      expect(result.status).toBe('COMPLETE');
      // Two timestamp requests: one for signature, one for archive
      expect(rfc3161Client.calls).toHaveLength(2);
    });

    it('should fail if certificate chain validation fails', async () => {
      vi.spyOn(certManager, 'validateChain').mockResolvedValue({
        valid: false,
        chain: [],
        trustAnchor: 'unknown',
        errors: ['Chain broken: leaf not issued by root'],
      });

      const cert = createTestCertificate();
      const request = createTestSignRequest();

      await expect(
        engine.sign(request, cert, 'org-001', 'user-001'),
      ).rejects.toThrow('Certificate chain validation failed');
    });

    it('should fail if certificate is revoked', async () => {
      ocspClient = createMockOcspClient('revoked');

      const qtspProvider = createQtspProvider(rfc3161Client, primaryTsa);
      const ltvBuilder = createLtvBuilder(certManager, ocspClient, crlManager);
      const ltvValidator = createLtvValidator();

      engine = new DefaultAdesEngine(
        hsm, certManager, ocspClient, crlManager, trustStore,
        qtspProvider, ltvBuilder, ltvValidator,
      );

      const cert = createTestCertificate();
      const request = createTestSignRequest();

      await expect(
        engine.sign(request, cert, 'org-001', 'user-001'),
      ).rejects.toThrow('Signing certificate is revoked');
    });

    it('should fail B-T if TSA is unavailable', async () => {
      rfc3161Client.shouldFail = true;
      rfc3161Client.failMessage = 'TSA connection timeout';

      const cert = createTestCertificate();
      const request = createTestSignRequest({ level: 'B-T' });

      await expect(
        engine.sign(request, cert, 'org-001', 'user-001'),
      ).rejects.toThrow('Timestamp required for level B-T but TSA failed');
    });

    it('should include signing certificate V2 in signed attributes', async () => {
      const cert = createTestCertificate();
      const request = createTestSignRequest({ level: 'B-B' });

      const result = await engine.sign(request, cert, 'org-001', 'user-001');

      expect(result.signedAttributes.signingCertificateV2).toBeDefined();
      expect(result.signedAttributes.signingTime).toBeTruthy();
      expect(result.signedAttributes.messageDigest).toBe(request.fingerprint);
    });

    it('should use correct algorithm for RSA keys', async () => {
      const cert = createTestCertificate({ keyAlgorithm: 'RSA-2048' });
      const request = createTestSignRequest({ level: 'B-B' });

      const result = await engine.sign(request, cert, 'org-001', 'user-001');

      expect(result.signatureAlgorithm).toBe('sha256WithRSAEncryption');
    });
  });

  // ─── Verify Tests ──────────────────────────────────────────────────

  describe('verify', () => {
    it('should verify a valid COMPLETE signature', async () => {
      const sig = createTestSignatureRecord({ status: 'COMPLETE' });

      const result = await engine.verify(sig);

      expect(result.valid).toBe(true);
      expect(result.signatureId).toBe(sig.publicId);
      expect(result.checks.signature_integrity.status).toBe('PASS');
      expect(result.checks.revocation_status.status).toBe('PASS');
    });

    it('should fail verification for REVOKED signature', async () => {
      const sig = createTestSignatureRecord({
        status: 'REVOKED',
        revokedAt: new Date(),
        revocationReason: 'KEY_COMPROMISE',
      });

      const result = await engine.verify(sig);

      expect(result.valid).toBe(false);
      expect(result.checks.revocation_status.status).toBe('FAIL');
    });

    it('should fail verification if timestamp missing on B-T signature', async () => {
      const sig = createTestSignatureRecord({
        level: 'B-T',
        timestampTokenId: null,
      });

      const result = await engine.verify(sig);

      expect(result.valid).toBe(false);
      expect(result.checks.timestamp_token.status).toBe('FAIL');
    });

    it('should fail verification if LTV data missing on B-LT signature', async () => {
      const sig = createTestSignatureRecord({
        level: 'B-LT',
        ltvDataEmbedded: false,
      });

      const result = await engine.verify(sig);

      expect(result.valid).toBe(false);
      expect(result.checks.ltv_data.status).toBe('FAIL');
    });

    it('should include eIDAS compliance info', async () => {
      const sig = createTestSignatureRecord({
        format: 'PAdES',
        level: 'B-T',
      });

      const result = await engine.verify(sig);

      expect(result.compliance).toBeDefined();
      expect(result.compliance?.etsiProfile).toContain('EN 319 142');
      expect(result.compliance?.etsiProfile).toContain('PAdES B-T');
    });

    it('should pass verification for B-LTA with all data present', async () => {
      const sig = createTestSignatureRecord({
        level: 'B-LTA',
        timestampTokenId: 'tst-001',
        ltvDataEmbedded: true,
        archiveTimestampId: 'arch-tst-001',
      });

      const result = await engine.verify(sig);

      expect(result.valid).toBe(true);
      expect(result.checks.timestamp_token.status).toBe('PASS');
      expect(result.checks.ltv_data.status).toBe('PASS');
      expect(result.checks.archive_timestamp.status).toBe('PASS');
    });
  });
});
