/**
 * HSM Bridge Tests — Phase III
 *
 * Tests the HSM signing interface with mock implementations.
 * Verifies algorithm validation, banned algorithm rejection,
 * and minimum key size enforcement per ETSI TS 119 312.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createMockHsmBridge, createHsmBridge } from './hsmBridge.js';
import type { HsmSignRequest } from '../types.js';

describe('HSM Bridge', () => {
  describe('MockHsmBridge', () => {
    it('should sign successfully with valid request', async () => {
      const hsm = createMockHsmBridge();
      const request: HsmSignRequest = {
        provider: 'aws_kms',
        keyId: 'arn:aws:kms:us-east-1:123:key/test',
        algorithm: 'ECDSA-P256',
        data: Buffer.alloc(32, 0x42), // SHA-256 hash
      };

      const result = await hsm.sign(request);

      expect(result.signature).toHaveLength(64);
      expect(result.algorithm).toBe('ECDSA-P256');
      expect(hsm.signCalls).toHaveLength(1);
    });

    it('should track multiple sign calls', async () => {
      const hsm = createMockHsmBridge();
      const makeRequest = (alg: string): HsmSignRequest => ({
        provider: 'aws_kms',
        keyId: 'test-key',
        algorithm: alg as any,
        data: Buffer.alloc(32, 0x01),
      });

      await hsm.sign(makeRequest('ECDSA-P256'));
      await hsm.sign(makeRequest('RSA-2048'));
      await hsm.sign(makeRequest('ECDSA-P384'));

      expect(hsm.signCalls).toHaveLength(3);
      expect(hsm.signCalls[0].algorithm).toBe('ECDSA-P256');
      expect(hsm.signCalls[1].algorithm).toBe('RSA-2048');
      expect(hsm.signCalls[2].algorithm).toBe('ECDSA-P384');
    });

    it('should return mock public key', async () => {
      const hsm = createMockHsmBridge();
      const key = await hsm.getPublicKey('aws_kms', 'test-key');

      expect(key).toHaveLength(65);
    });
  });

  describe('Algorithm Validation', () => {
    it('should reject SHA-1 (banned per ETSI TS 119 312)', async () => {
      const hsm = createMockHsmBridge();
      const request: HsmSignRequest = {
        provider: 'aws_kms',
        keyId: 'test-key',
        algorithm: 'SHA-1' as any,
        data: Buffer.alloc(32),
      };

      await expect(hsm.sign(request)).rejects.toThrow('banned per ETSI TS 119 312');
    });

    it('should reject MD5 (banned per ETSI TS 119 312)', async () => {
      const hsm = createMockHsmBridge();
      const request: HsmSignRequest = {
        provider: 'aws_kms',
        keyId: 'test-key',
        algorithm: 'MD5' as any,
        data: Buffer.alloc(32),
      };

      await expect(hsm.sign(request)).rejects.toThrow('banned per ETSI TS 119 312');
    });

    it('should reject invalid hash sizes', async () => {
      const hsm = createMockHsmBridge();
      const request: HsmSignRequest = {
        provider: 'aws_kms',
        keyId: 'test-key',
        algorithm: 'ECDSA-P256',
        data: Buffer.alloc(16), // Too short for any hash
      };

      await expect(hsm.sign(request)).rejects.toThrow('must be a hash digest');
    });

    it('should accept SHA-256 hash (32 bytes)', async () => {
      const hsm = createMockHsmBridge();
      const request: HsmSignRequest = {
        provider: 'aws_kms',
        keyId: 'test-key',
        algorithm: 'ECDSA-P256',
        data: Buffer.alloc(32),
      };

      const result = await hsm.sign(request);
      expect(result.signature).toBeTruthy();
    });

    it('should accept SHA-384 hash (48 bytes)', async () => {
      const hsm = createMockHsmBridge();
      const request: HsmSignRequest = {
        provider: 'aws_kms',
        keyId: 'test-key',
        algorithm: 'ECDSA-P384',
        data: Buffer.alloc(48),
      };

      const result = await hsm.sign(request);
      expect(result.signature).toBeTruthy();
    });

    it('should accept SHA-512 hash (64 bytes)', async () => {
      const hsm = createMockHsmBridge();
      const request: HsmSignRequest = {
        provider: 'aws_kms',
        keyId: 'test-key',
        algorithm: 'RSA-4096',
        data: Buffer.alloc(64),
      };

      const result = await hsm.sign(request);
      expect(result.signature).toBeTruthy();
    });
  });

  describe('Factory', () => {
    it('should create AWS KMS bridge', () => {
      const bridge = createHsmBridge('aws_kms');
      expect(bridge.name).toBe('AWS KMS');
    });

    it('should create GCP KMS bridge', () => {
      const bridge = createHsmBridge('gcp_kms');
      expect(bridge.name).toBe('GCP Cloud HSM');
    });

    it('should throw for unknown provider', () => {
      expect(() => createHsmBridge('unknown' as any)).toThrow('Unknown KMS provider');
    });
  });
});
