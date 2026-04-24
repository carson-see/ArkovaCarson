/**
 * NPH-12: Fraud Signal Training Data Pipeline Tests
 *
 * TDD: Tests written first for fraud training data generation.
 * Validates JSONL output, balanced classes, augmentation, PII safety.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateFraudTrainingData,
  augmentFraudExample,
  formatFraudTrainingLine,
  deduplicateExamples,
  DIPLOMA_MILLS,
  SUSPICIOUS_PHRASES,
} from './fraud-training-pipeline.js';
import type { FraudTrainingExample } from './fraud-training-pipeline.js';

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Fraud Training Pipeline (NPH-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatFraudTrainingLine', () => {
    it('produces valid JSONL with input/output structure', () => {
      const example: FraudTrainingExample = {
        input: 'University of [REDACTED]. Bachelor of Science. Date: 2025-01-15.',
        output: {
          fraudSignals: [],
          reasoning: 'Legitimate university degree with standard formatting.',
          riskLevel: 'LOW',
        },
        source: 'golden-dataset',
        isFraud: false,
      };

      const line = formatFraudTrainingLine(example);
      const parsed = JSON.parse(line);

      expect(parsed).toHaveProperty('input');
      expect(parsed).toHaveProperty('output');
      expect(parsed.output).toHaveProperty('fraudSignals');
      expect(parsed.output).toHaveProperty('reasoning');
      expect(parsed.output).toHaveProperty('riskLevel');
    });

    it('serializes fraud signals as array', () => {
      const example: FraudTrainingExample = {
        input: 'Diploma from [REDACTED] Accredited Institute.',
        output: {
          fraudSignals: ['unaccredited_institution', 'suspicious_formatting'],
          reasoning: 'Known diploma mill pattern.',
          riskLevel: 'HIGH',
        },
        source: 'fraud-eval',
        isFraud: true,
      };

      const parsed = JSON.parse(formatFraudTrainingLine(example));
      expect(Array.isArray(parsed.output.fraudSignals)).toBe(true);
      expect(parsed.output.fraudSignals).toHaveLength(2);
    });

    it('riskLevel is one of LOW, MEDIUM, HIGH, CRITICAL', () => {
      for (const riskLevel of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const) {
        const example: FraudTrainingExample = {
          input: 'Test text.',
          output: { fraudSignals: [], reasoning: 'Test.', riskLevel },
          source: 'test',
          isFraud: false,
        };
        const parsed = JSON.parse(formatFraudTrainingLine(example));
        expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(parsed.output.riskLevel);
      }
    });
  });

  describe('augmentFraudExample', () => {
    const baseText = 'This is to certify that [NAME_REDACTED] has been awarded the degree of Bachelor of Arts on May 15, 2024 from the University of [REDACTED].';

    it('generates date-shifted variations', () => {
      const variations = augmentFraudExample(baseText, 'date_shift');
      expect(variations.length).toBeGreaterThanOrEqual(1);
      // Should contain modified dates (future dates are suspicious)
      for (const v of variations) {
        expect(v.length).toBeGreaterThan(10);
      }
    });

    it('generates issuer-substituted variations with known diploma mills', () => {
      const variations = augmentFraudExample(baseText, 'issuer_substitution');
      expect(variations.length).toBeGreaterThanOrEqual(1);
      // Should swap in diploma mill names
      const hasMillName = variations.some(v =>
        DIPLOMA_MILLS.some(mill => v.includes(mill)),
      );
      expect(hasMillName).toBe(true);
    });

    it('generates content-modified variations with suspicious phrases', () => {
      const variations = augmentFraudExample(baseText, 'content_modification');
      expect(variations.length).toBeGreaterThanOrEqual(1);
      const hasSuspicious = variations.some(v =>
        SUSPICIOUS_PHRASES.some(phrase => v.toLowerCase().includes(phrase.toLowerCase())),
      );
      expect(hasSuspicious).toBe(true);
    });

    it('returns non-empty text for all variations', () => {
      for (const strategy of ['date_shift', 'issuer_substitution', 'content_modification'] as const) {
        const variations = augmentFraudExample(baseText, strategy);
        for (const v of variations) {
          expect(v.trim().length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('deduplicateExamples', () => {
    it('removes exact duplicates by input text', () => {
      const examples: FraudTrainingExample[] = [
        { input: 'same text', output: { fraudSignals: [], reasoning: 'a', riskLevel: 'LOW' }, source: 'a', isFraud: false },
        { input: 'same text', output: { fraudSignals: [], reasoning: 'b', riskLevel: 'LOW' }, source: 'b', isFraud: false },
        { input: 'different text', output: { fraudSignals: [], reasoning: 'c', riskLevel: 'LOW' }, source: 'c', isFraud: false },
      ];
      const deduped = deduplicateExamples(examples);
      expect(deduped).toHaveLength(2);
    });

    it('keeps first occurrence when duplicates found', () => {
      const examples: FraudTrainingExample[] = [
        { input: 'dup', output: { fraudSignals: [], reasoning: 'first', riskLevel: 'LOW' }, source: 'a', isFraud: false },
        { input: 'dup', output: { fraudSignals: ['x'], reasoning: 'second', riskLevel: 'HIGH' }, source: 'b', isFraud: true },
      ];
      const deduped = deduplicateExamples(examples);
      expect(deduped[0].output.reasoning).toBe('first');
    });
  });

  describe('generateFraudTrainingData', () => {
    it('returns a valid FraudPipelineResult', () => {
      const result = generateFraudTrainingData({ outputPath: '/tmp/test-fraud.jsonl' });
      expect(result).toHaveProperty('totalExamples');
      expect(result).toHaveProperty('fraudExamples');
      expect(result).toHaveProperty('cleanExamples');
      expect(result).toHaveProperty('outputPath');
    });

    it('generates balanced classes (40-60% split)', () => {
      const result = generateFraudTrainingData({ outputPath: '/tmp/test-fraud.jsonl' });
      const fraudRatio = result.fraudExamples / result.totalExamples;
      expect(fraudRatio).toBeGreaterThanOrEqual(0.4);
      expect(fraudRatio).toBeLessThanOrEqual(0.6);
    });

    it('generates at least 100 total examples', () => {
      const result = generateFraudTrainingData({ outputPath: '/tmp/test-fraud.jsonl' });
      expect(result.totalExamples).toBeGreaterThanOrEqual(100);
    });

    it('contains no real PII in output (no unredacted emails)', () => {
      const result = generateFraudTrainingData({
        outputPath: '/tmp/test-fraud.jsonl',
        returnExamples: true,
      });
      // Real email addresses should never appear (redacted ones like [EMAIL_REDACTED] are fine)
      const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

      for (const example of result.examples ?? []) {
        expect(example.input).not.toMatch(emailPattern);
      }
    });

    it('all examples have non-empty reasoning', () => {
      const result = generateFraudTrainingData({
        outputPath: '/tmp/test-fraud.jsonl',
        returnExamples: true,
      });
      for (const example of result.examples ?? []) {
        expect(example.output.reasoning.length).toBeGreaterThan(5);
      }
    });

    it('fraud examples have non-empty fraudSignals', () => {
      const result = generateFraudTrainingData({
        outputPath: '/tmp/test-fraud.jsonl',
        returnExamples: true,
      });
      // The pipeline should produce fraud examples (from golden+eval datasets)
      expect(result.fraudExamples).toBeGreaterThan(0);
      const fraudExamples = (result.examples ?? []).filter(e => e.isFraud);
      // At least some fraud examples should exist
      expect(fraudExamples.length).toBeGreaterThan(0);
      for (const example of fraudExamples) {
        expect(example.output.fraudSignals.length).toBeGreaterThan(0);
      }
    });

    it('clean examples have empty fraudSignals', () => {
      const result = generateFraudTrainingData({
        outputPath: '/tmp/test-fraud.jsonl',
        returnExamples: true,
      });
      const cleanExamples = (result.examples ?? []).filter(e => !e.isFraud);
      for (const example of cleanExamples) {
        expect(example.output.fraudSignals).toHaveLength(0);
      }
    });

    it('writes JSONL file when outputPath is provided', async () => {
      const fs = await import('node:fs');
      const writeFileSyncSpy = vi.mocked(fs.writeFileSync);
      writeFileSyncSpy.mockClear();
      generateFraudTrainingData({ outputPath: '/tmp/test-fraud-output.jsonl' });
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        '/tmp/test-fraud-output.jsonl',
        expect.any(String),
        'utf-8',
      );
    });

    it('each JSONL line is valid JSON', () => {
      const result = generateFraudTrainingData({
        outputPath: '/tmp/test-fraud.jsonl',
        returnExamples: true,
      });
      for (const example of result.examples ?? []) {
        const line = formatFraudTrainingLine(example);
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
