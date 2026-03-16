/**
 * Tests for Replicate QA Data Generator (INFRA-06).
 *
 * Verifies production blocking, synthetic data generation,
 * deterministic embeddings, and IAIProvider contract compliance.
 *
 * Constitution 1.1: replicate is QA/synthetic-data-only.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ReplicateProvider } from './replicate.js';

describe('ReplicateProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('constructor', () => {
    it('creates provider with valid token in non-production env', () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');
      expect(provider).toBeDefined();
      expect(provider.name).toBe('replicate-qa');
    });

    it('throws in production without ENABLE_SYNTHETIC_DATA', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ENABLE_SYNTHETIC_DATA;

      expect(() => new ReplicateProvider('r8_test_token_123')).toThrow(
        'ReplicateProvider is blocked in production',
      );
    });

    it('allows production when ENABLE_SYNTHETIC_DATA=true', () => {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_SYNTHETIC_DATA = 'true';

      const provider = new ReplicateProvider('r8_test_token_123');
      expect(provider).toBeDefined();
    });

    it('throws without API token', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.REPLICATE_API_TOKEN;

      expect(() => new ReplicateProvider()).toThrow(
        'REPLICATE_API_TOKEN is required',
      );
    });

    it('reads token from env when not passed explicitly', () => {
      process.env.NODE_ENV = 'test';
      process.env.REPLICATE_API_TOKEN = 'r8_env_token';

      const provider = new ReplicateProvider();
      expect(provider).toBeDefined();
    });
  });

  describe('extractMetadata', () => {
    it('returns synthetic fields matching the request', async () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');

      const result = await provider.extractMetadata({
        strippedText: 'Bachelor of Science in Computer Science',
        credentialType: 'DEGREE',
        fingerprint: 'abc12345def67890',
      });

      expect(result.fields.credentialType).toBe('DEGREE');
      expect(result.fields.issuerName).toBe('Test University');
      expect(result.fields.recipientIdentifier).toBe('sha256:synthetic_abc12345');
      expect(result.fields.issuedDate).toBe('2024-06-15');
      expect(result.fields.expiryDate).toBe('2028-06-15');
      expect(result.fields.fieldOfStudy).toBe('Computer Science');
      expect(result.fields.degreeLevel).toBe('Bachelor of Science');
      expect(result.confidence).toBe(0.95);
      expect(result.provider).toBe('replicate-qa');
      expect(result.tokensUsed).toBe(0);
    });

    it('uses issuerHint when provided', async () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');

      const result = await provider.extractMetadata({
        strippedText: 'Certificate of Completion',
        credentialType: 'CERTIFICATE',
        fingerprint: 'ffee1122aabb3344',
        issuerHint: 'MIT',
      });

      expect(result.fields.issuerName).toBe('MIT');
    });
  });

  describe('generateEmbedding', () => {
    it('returns 768-dimensional array', async () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');

      const result = await provider.generateEmbedding('test input text');

      expect(result.embedding).toHaveLength(768);
      expect(result.model).toBe('replicate-qa-synthetic');
      result.embedding.forEach((v) => {
        expect(typeof v).toBe('number');
        expect(Number.isFinite(v)).toBe(true);
      });
    });

    it('is deterministic — same input produces same output', async () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');

      const result1 = await provider.generateEmbedding('deterministic test');
      const result2 = await provider.generateEmbedding('deterministic test');

      expect(result1.embedding).toEqual(result2.embedding);
    });

    it('produces different output for different input', async () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');

      const result1 = await provider.generateEmbedding('input A');
      const result2 = await provider.generateEmbedding('input B');

      expect(result1.embedding).not.toEqual(result2.embedding);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when token is set', async () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.provider).toBe('replicate-qa');
      expect(health.mode).toBe('qa-synthetic');
      expect(typeof health.latencyMs).toBe('number');
    });
  });

  describe('provider name', () => {
    it('is replicate-qa', () => {
      process.env.NODE_ENV = 'test';
      const provider = new ReplicateProvider('r8_test_token_123');
      expect(provider.name).toBe('replicate-qa');
    });
  });
});
