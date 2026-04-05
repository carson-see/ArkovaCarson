/**
 * Timestamp Validator Tests — Phase III
 *
 * Story: PH3-ESIG-02 (SCRUM-423)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DefaultTimestampValidator, createMockTimestampValidator } from './timestampValidator.js';
import { createMockTrustStore } from '../pki/trustStore.js';
import type { TimestampToken } from '../types.js';

function createTestToken(overrides?: Partial<TimestampToken>): TimestampToken {
  return {
    id: 'tst-001',
    orgId: 'org-001',
    signatureId: 'sig-001',
    messageImprint: 'a'.repeat(64),
    hashAlgorithm: 'SHA-256',
    tstData: Buffer.from('mock-tst-data'),
    tstSerial: '1234567890abcdef',
    tstGenTime: new Date(),
    tsaName: 'DigiCert TSA',
    tsaUrl: 'https://timestamp.digicert.com',
    tsaCertFingerprint: 'b'.repeat(64),
    qtspQualified: true,
    tokenType: 'SIGNATURE',
    costUsd: 0.01,
    providerRef: null,
    verifiedAt: null,
    verificationStatus: 'UNVERIFIED',
    createdAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe('Timestamp Validator', () => {
  it('should validate a correct timestamp token', async () => {
    const trustStore = createMockTrustStore();
    const validator = new DefaultTimestampValidator(trustStore);
    const hash = Buffer.from('a'.repeat(64), 'hex');
    const token = createTestToken({ messageImprint: hash.toString('hex') });

    const result = await validator.verify(token, hash);

    expect(result.status).toBe('VALID');
    expect(result.errors).toHaveLength(0);
    expect(result.tsaName).toBe('DigiCert TSA');
    expect(result.qualified).toBe(true);
  });

  it('should fail for empty TST data', async () => {
    const trustStore = createMockTrustStore();
    const validator = new DefaultTimestampValidator(trustStore);
    const hash = Buffer.alloc(32);
    const token = createTestToken({ tstData: Buffer.alloc(0) });

    const result = await validator.verify(token, hash);

    expect(result.status).toBe('INVALID');
    expect(result.errors).toContain('TST data is empty');
  });

  it('should fail for message imprint mismatch', async () => {
    const trustStore = createMockTrustStore();
    const validator = new DefaultTimestampValidator(trustStore);
    const hash = Buffer.alloc(32, 0x42);
    const token = createTestToken({ messageImprint: 'cc'.repeat(32) });

    const result = await validator.verify(token, hash);

    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.includes('imprint mismatch'))).toBe(true);
  });

  it('should fail for future genTime', async () => {
    const trustStore = createMockTrustStore();
    const validator = new DefaultTimestampValidator(trustStore);
    const hash = Buffer.from('a'.repeat(64), 'hex');
    const futureTime = new Date(Date.now() + 10 * 60_000); // 10 min in future
    const token = createTestToken({
      messageImprint: hash.toString('hex'),
      tstGenTime: futureTime,
    });

    const result = await validator.verify(token, hash);

    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.includes('future'))).toBe(true);
  });

  it('should warn for old timestamps (>10 years)', async () => {
    const trustStore = createMockTrustStore();
    const validator = new DefaultTimestampValidator(trustStore);
    const hash = Buffer.from('a'.repeat(64), 'hex');
    const oldTime = new Date('2010-01-01');
    const token = createTestToken({
      messageImprint: hash.toString('hex'),
      tstGenTime: oldTime,
    });

    const result = await validator.verify(token, hash);

    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.includes('older than 10 years'))).toBe(true);
  });

  it('should reject unacceptable hash algorithms', async () => {
    const trustStore = createMockTrustStore();
    const validator = new DefaultTimestampValidator(trustStore);
    const hash = Buffer.from('a'.repeat(64), 'hex');
    const token = createTestToken({
      messageImprint: hash.toString('hex'),
      hashAlgorithm: 'SHA-1',
    });

    const result = await validator.verify(token, hash);

    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.includes('Unacceptable hash algorithm'))).toBe(true);
  });

  describe('MockTimestampValidator', () => {
    it('should track verify calls', async () => {
      const mock = createMockTimestampValidator();
      const token = createTestToken();
      const hash = Buffer.alloc(32);

      await mock.verify(token, hash);
      await mock.verify(token, hash);

      expect(mock.verifyCalls).toHaveLength(2);
    });

    it('should return configurable default status', async () => {
      const mock = createMockTimestampValidator();
      mock.defaultStatus = 'EXPIRED';
      const token = createTestToken();

      const result = await mock.verify(token, Buffer.alloc(32));

      expect(result.status).toBe('EXPIRED');
    });
  });
});
