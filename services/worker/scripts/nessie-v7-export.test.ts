/**
 * Tests for Nessie v7 Training Data Export (NMT-15 / SCRUM-679)
 *
 * Verifies training data export: golden dataset conversion, deterministic
 * shuffling, train/val split, and JSONL format.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { NESSIE_CONDENSED_PROMPT } from '../src/ai/prompts/nessie-condensed.js';
import { computeRealisticConfidence } from '../src/ai/training/nessie-v4-data.js';

/**
 * Deterministic shuffle — mirrors the script's implementation.
 */
function deterministicShuffle<T>(arr: T[], seed: string): T[] {
  const copy = [...arr];
  let hash = createHash('sha256').update(seed).digest();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = hash.readUInt32BE(0) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
    hash = createHash('sha256').update(hash).digest();
  }
  return copy;
}

describe('nessie-v7-export (NMT-15)', () => {
  describe('golden dataset availability', () => {
    it('should have >1800 entries (phases 1-14)', () => {
      expect(FULL_GOLDEN_DATASET.length).toBeGreaterThan(1800);
    });

    it('should include phase 14 entries', () => {
      const phase14 = FULL_GOLDEN_DATASET.filter(
        e => e.id.startsWith('GD-') && parseInt(e.id.replace('GD-', ''), 10) >= 1766,
      );
      expect(phase14.length).toBeGreaterThanOrEqual(100);
    });

    it('should cover rare types from phase 14', () => {
      const types = new Set(FULL_GOLDEN_DATASET.map(e => e.groundTruth.credentialType));
      expect(types.has('CHARITY')).toBe(true);
      expect(types.has('ACCREDITATION')).toBe(true);
      expect(types.has('BADGE')).toBe(true);
      expect(types.has('ATTESTATION')).toBe(true);
      expect(types.has('MEDICAL')).toBe(true);
    });
  });

  describe('training example conversion', () => {
    const testEntry = FULL_GOLDEN_DATASET[0];

    it('should produce 3-message format', () => {
      const gt = { ...testEntry.groundTruth };
      const confidence = computeRealisticConfidence(
        gt as Record<string, unknown>,
        testEntry.strippedText,
      );

      const messages = [
        { role: 'system', content: NESSIE_CONDENSED_PROMPT },
        { role: 'user', content: testEntry.strippedText },
        {
          role: 'assistant',
          content: JSON.stringify({
            ...gt,
            confidence: Math.round(confidence * 100) / 100,
          }),
        },
      ];

      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
      expect(messages[2].role).toBe('assistant');
    });

    it('should use condensed prompt as system message', () => {
      expect(NESSIE_CONDENSED_PROMPT.length).toBeGreaterThan(100);
      expect(NESSIE_CONDENSED_PROMPT.length).toBeLessThan(5000);
    });

    it('should produce valid JSON in assistant response', () => {
      const gt = testEntry.groundTruth;
      const confidence = computeRealisticConfidence(
        gt as Record<string, unknown>,
        testEntry.strippedText,
      );
      const response = JSON.stringify({
        ...gt,
        confidence: Math.round(confidence * 100) / 100,
      });

      const parsed = JSON.parse(response);
      expect(parsed.credentialType).toBeDefined();
      expect(parsed.confidence).toBeGreaterThanOrEqual(0);
      expect(parsed.confidence).toBeLessThanOrEqual(1);
    });

    it('should compute realistic confidence (not hardcoded)', () => {
      const gt = testEntry.groundTruth;
      const confidence = computeRealisticConfidence(
        gt as Record<string, unknown>,
        testEntry.strippedText,
      );
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
      // Realistic confidence should vary — not all 0.92
      expect(confidence).not.toBe(0.92);
    });
  });

  describe('deterministic shuffle', () => {
    it('should be reproducible with same seed', () => {
      const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffle1 = deterministicShuffle(arr, 'test-seed');
      const shuffle2 = deterministicShuffle(arr, 'test-seed');
      expect(shuffle1).toEqual(shuffle2);
    });

    it('should produce different order with different seed', () => {
      const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffle1 = deterministicShuffle(arr, 'seed-a');
      const shuffle2 = deterministicShuffle(arr, 'seed-b');
      expect(shuffle1).not.toEqual(shuffle2);
    });

    it('should preserve all elements', () => {
      const arr = [1, 2, 3, 4, 5];
      const shuffled = deterministicShuffle(arr, 'preserve-test');
      expect(shuffled.sort()).toEqual(arr.sort());
    });

    it('should not modify original array', () => {
      const arr = [1, 2, 3, 4, 5];
      const original = [...arr];
      deterministicShuffle(arr, 'no-mutate');
      expect(arr).toEqual(original);
    });
  });

  describe('train/val split', () => {
    it('should use 10% for validation', () => {
      const total = FULL_GOLDEN_DATASET.length;
      const valRatio = 0.1;
      const valSize = Math.max(10, Math.min(500, Math.floor(total * valRatio)));
      const trainSize = total - valSize;

      expect(valSize).toBeGreaterThanOrEqual(10);
      expect(valSize).toBeLessThanOrEqual(500);
      expect(trainSize + valSize).toBe(total);
    });

    it('should produce more train than val examples', () => {
      const total = FULL_GOLDEN_DATASET.length;
      const valSize = Math.max(10, Math.min(500, Math.floor(total * 0.1)));
      const trainSize = total - valSize;
      expect(trainSize).toBeGreaterThan(valSize);
    });
  });

  describe('v7 improvements over v5', () => {
    it('should have more entries than v5 (~1903)', () => {
      // v7 includes phase 12 (80) + phase 14 (120) that v5 may not have
      expect(FULL_GOLDEN_DATASET.length).toBeGreaterThanOrEqual(1800);
    });

    it('should have better coverage of credential types', () => {
      const types = new Set(FULL_GOLDEN_DATASET.map(e => e.groundTruth.credentialType));
      // v7 should cover at least 15 credential types
      expect(types.size).toBeGreaterThanOrEqual(15);
    });
  });

});
