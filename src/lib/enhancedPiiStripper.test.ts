/**
 * Enhanced PII Stripper Tests (Phase 4)
 *
 * Tests the combined regex + NER stripping pipeline.
 * Mocks the NER detector for unit testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the NER detector
vi.mock('./nerPiiDetector', () => ({
  detectPIIWithNER: vi.fn(),
  redactNEREntities: vi.fn(),
  disposeNERPipeline: vi.fn(),
}));

// Mock ML runtime
vi.mock('./mlRuntime', () => ({
  detectMLRuntime: vi.fn().mockResolvedValue({
    backend: 'wasm',
    webgpuAvailable: false,
    wasmSimdAvailable: true,
    estimatedVramMb: null,
    withinBudget: true,
  }),
}));

import { stripPIIEnhanced } from './enhancedPiiStripper';
import { detectPIIWithNER, redactNEREntities } from './nerPiiDetector';

const mockDetectPII = vi.mocked(detectPIIWithNER);
const mockRedact = vi.mocked(redactNEREntities);

describe('enhancedPiiStripper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('regex-only mode', () => {
    it('strips SSN with NER disabled', async () => {
      const result = await stripPIIEnhanced(
        'SSN: 123-45-6789',
        { enableNER: false },
      );
      expect(result.strippedText).toContain('[SSN_REDACTED]');
      expect(result.nerUsed).toBe(false);
      expect(result.nerResult).toBeNull();
    });

    it('strips email with NER disabled', async () => {
      const result = await stripPIIEnhanced(
        'Contact: john@example.com',
        { enableNER: false },
      );
      expect(result.strippedText).toContain('[EMAIL_REDACTED]');
      expect(result.nerUsed).toBe(false);
    });

    it('strips phone with NER disabled', async () => {
      const result = await stripPIIEnhanced(
        'Call (555) 123-4567',
        { enableNER: false },
      );
      expect(result.strippedText).toContain('[PHONE_REDACTED]');
    });

    it('returns all regex PII categories', async () => {
      const result = await stripPIIEnhanced(
        'SSN: 123-45-6789, email: a@b.com, phone: (555) 123-4567',
        { enableNER: false },
      );
      expect(result.piiFound).toContain('ssn');
      expect(result.piiFound).toContain('email');
      expect(result.piiFound).toContain('phone');
      expect(result.allPiiCategories).toEqual(result.piiFound);
    });
  });

  describe('NER-enhanced mode', () => {
    it('runs NER after regex stripping', async () => {
      mockDetectPII.mockResolvedValue({
        entities: [
          { text: 'John Smith', type: 'PERSON', score: 0.95, start: 0, end: 10 },
        ],
        piiCategories: ['person_name'],
        entityCount: 1,
        modelLoadTimeMs: 100,
        inferenceTimeMs: 50,
        backend: 'wasm',
      });
      mockRedact.mockReturnValue('[PERSON_REDACTED] has SSN [SSN_REDACTED]');

      const result = await stripPIIEnhanced('John Smith has SSN 123-45-6789');
      expect(result.nerUsed).toBe(true);
      expect(result.nerResult).not.toBeNull();
      expect(result.allPiiCategories).toContain('ssn');
      expect(result.allPiiCategories).toContain('person_name');
    });

    it('returns regex-only results if NER finds nothing', async () => {
      mockDetectPII.mockResolvedValue({
        entities: [],
        piiCategories: [],
        entityCount: 0,
        modelLoadTimeMs: 100,
        inferenceTimeMs: 50,
        backend: 'wasm',
      });

      const result = await stripPIIEnhanced('SSN: 123-45-6789');
      expect(result.nerUsed).toBe(true);
      expect(result.nerResult?.entityCount).toBe(0);
      expect(result.strippedText).toContain('[SSN_REDACTED]');
    });

    it('falls back to regex-only on NER error', async () => {
      mockDetectPII.mockRejectedValue(new Error('Model load failed'));

      const result = await stripPIIEnhanced('SSN: 123-45-6789');
      expect(result.nerUsed).toBe(false);
      expect(result.nerResult).toBeNull();
      expect(result.strippedText).toContain('[SSN_REDACTED]');
    });

    it('merges redaction counts from regex and NER', async () => {
      mockDetectPII.mockResolvedValue({
        entities: [
          { text: 'Alice', type: 'PERSON', score: 0.9, start: 0, end: 5 },
          { text: 'Bob', type: 'PERSON', score: 0.88, start: 10, end: 13 },
        ],
        piiCategories: ['person_name'],
        entityCount: 2,
        modelLoadTimeMs: 100,
        inferenceTimeMs: 50,
        backend: 'wasm',
      });
      mockRedact.mockReturnValue('[PERSON_REDACTED] and [PERSON_REDACTED] at [EMAIL_REDACTED]');

      const result = await stripPIIEnhanced('Alice and Bob at test@example.com');
      // 1 email regex + 2 NER entities = 3 total
      expect(result.redactionCount).toBe(3);
    });

    it('passes NER progress callbacks', async () => {
      const progressCalls: string[] = [];
      mockDetectPII.mockResolvedValue({
        entities: [],
        piiCategories: [],
        entityCount: 0,
        modelLoadTimeMs: 0,
        inferenceTimeMs: 0,
        backend: 'wasm',
      });

      await stripPIIEnhanced('test text', {
        onNERProgress: (p) => progressCalls.push(p.stage),
      });

      // The progress callback is passed through to detectPIIWithNER
      expect(mockDetectPII).toHaveBeenCalledWith(
        expect.any(String),
        'wasm',
        expect.any(Function),
      );
    });
  });

  describe('report shape', () => {
    it('includes all required fields', async () => {
      mockDetectPII.mockResolvedValue({
        entities: [],
        piiCategories: [],
        entityCount: 0,
        modelLoadTimeMs: 0,
        inferenceTimeMs: 0,
        backend: 'wasm',
      });

      const result = await stripPIIEnhanced('test text');
      expect(result).toHaveProperty('strippedText');
      expect(result).toHaveProperty('piiFound');
      expect(result).toHaveProperty('redactionCount');
      expect(result).toHaveProperty('originalLength');
      expect(result).toHaveProperty('strippedLength');
      expect(result).toHaveProperty('nerUsed');
      expect(result).toHaveProperty('nerResult');
      expect(result).toHaveProperty('allPiiCategories');
    });

    it('preserves original/stripped length', async () => {
      const text = 'SSN: 123-45-6789';
      const result = await stripPIIEnhanced(text, { enableNER: false });
      expect(result.originalLength).toBe(text.length);
      expect(result.strippedLength).toBe(result.strippedText.length);
    });
  });
});
