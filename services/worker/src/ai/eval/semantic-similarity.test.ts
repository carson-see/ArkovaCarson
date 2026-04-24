/**
 * Tests for semantic-similarity scoring (NVI-17)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cosineSimilarity,
  semanticSimilarityScore,
  semanticFaithfulness,
  semanticRelevance,
  semanticRiskDetection,
} from './semantic-similarity.js';

describe('semantic-similarity', () => {
  describe('cosineSimilarity', () => {
    it('returns 1.0 for identical vectors', () => {
      const v = [0.1, 0.2, 0.3, 0.4];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
    });

    it('returns -1 for opposite vectors', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
    });

    it('returns 0 for zero vectors', () => {
      expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    it('returns 0 for mismatched dimensions', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('handles high-dimensional vectors', () => {
      const a = Array.from({ length: 768 }, (_, i) => Math.sin(i));
      const b = Array.from({ length: 768 }, (_, i) => Math.sin(i + 0.1));
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThan(0.9);
      expect(sim).toBeLessThanOrEqual(1.0);
    });
  });

  describe('semanticSimilarityScore', () => {
    const mockEmbed = vi.fn<(text: string) => Promise<number[]>>();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns 1.0 for identical texts', async () => {
      const vec = [0.5, 0.3, 0.1];
      mockEmbed.mockResolvedValue(vec);
      const score = await semanticSimilarityScore('hello', 'hello', mockEmbed);
      expect(score).toBeCloseTo(1.0, 5);
    });

    it('returns similarity between different texts', async () => {
      mockEmbed
        .mockResolvedValueOnce([1, 0, 0])
        .mockResolvedValueOnce([0.7, 0.7, 0]);
      const score = await semanticSimilarityScore('text a', 'text b', mockEmbed);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });

    it('handles embed function errors gracefully', async () => {
      mockEmbed.mockRejectedValue(new Error('API error'));
      const score = await semanticSimilarityScore('a', 'b', mockEmbed);
      expect(score).toBe(0);
    });
  });

  describe('semanticFaithfulness', () => {
    const mockEmbed = vi.fn<(text: string) => Promise<number[]>>();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns high score when answer is semantically similar to context', async () => {
      const baseVec = [0.5, 0.3, 0.8, 0.1];
      mockEmbed.mockResolvedValue(baseVec);

      const score = await semanticFaithfulness(
        'FCRA requires permissible purpose for consumer reports',
        ['The Fair Credit Reporting Act mandates permissible purpose checks'],
        mockEmbed,
      );
      expect(score).toBeCloseTo(1.0, 1);
    });

    it('returns 0 for empty answer', async () => {
      const score = await semanticFaithfulness('', ['context'], mockEmbed);
      expect(score).toBe(0);
    });

    it('returns 0 for empty context', async () => {
      const score = await semanticFaithfulness('answer', [], mockEmbed);
      expect(score).toBe(0);
    });

    it('splits answer into sentences and scores each against context', async () => {
      let callCount = 0;
      mockEmbed.mockImplementation(async () => {
        callCount++;
        return [Math.sin(callCount), Math.cos(callCount), 0.5];
      });

      const answer = 'First sentence about FCRA. Second sentence about HIPAA.';
      const context = ['FCRA compliance requirements for employers.'];

      const score = await semanticFaithfulness(answer, context, mockEmbed);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('semanticRelevance', () => {
    const mockEmbed = vi.fn<(text: string) => Promise<number[]>>();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns high score when answer covers all key points', async () => {
      const vec = [0.5, 0.5, 0.5];
      mockEmbed.mockResolvedValue(vec);

      const score = await semanticRelevance(
        'The adverse action process requires notice under FCRA 604(b)',
        ['adverse action notice', 'FCRA 604(b) requirements'],
        mockEmbed,
      );
      expect(score).toBeCloseTo(1.0, 1);
    });

    it('returns 1.0 when no key points expected', async () => {
      const score = await semanticRelevance('any answer', [], mockEmbed);
      expect(score).toBe(1.0);
    });

    it('returns 0 for empty answer', async () => {
      const score = await semanticRelevance('', ['key point'], mockEmbed);
      expect(score).toBe(0);
    });
  });

  describe('semanticRiskDetection', () => {
    const mockEmbed = vi.fn<(text: string) => Promise<number[]>>();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns high score when detected risks match expected', async () => {
      const vec = [0.5, 0.5, 0.5];
      mockEmbed.mockResolvedValue(vec);

      const score = await semanticRiskDetection(
        ['FCRA violation: missing permissible purpose'],
        ['Missing permissible purpose check under FCRA'],
        mockEmbed,
      );
      expect(score).toBeCloseTo(1.0, 1);
    });

    it('returns 1.0 when no risks expected', async () => {
      const score = await semanticRiskDetection([], [], mockEmbed);
      expect(score).toBe(1.0);
    });

    it('returns 0 when detected risks are empty but expected are not', async () => {
      mockEmbed.mockResolvedValue([0.5, 0.5]);
      const score = await semanticRiskDetection(
        ['Expected risk'],
        [],
        mockEmbed,
      );
      expect(score).toBe(0);
    });

    it('uses answer as fallback for matching', async () => {
      let callCount = 0;
      mockEmbed.mockImplementation(async () => {
        callCount++;
        return [0.5, 0.5, callCount * 0.1];
      });

      const score = await semanticRiskDetection(
        ['Missing adverse action notice'],
        [],
        mockEmbed,
        'The employer failed to provide adverse action notice as required by FCRA',
      );
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });
});
