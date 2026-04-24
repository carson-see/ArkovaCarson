/**
 * SCRUM-861: Contract reasoning dataset tests.
 *
 * Validates risk-flag reasoning, recommendation URL registry coverage, and the
 * 20% human-review sample marker required by the story.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_REASONING_CATEGORY_COUNTS,
  CONTRACT_REASONING_HUMAN_REVIEW_SAMPLE_SIZE,
  GOLDEN_DATASET_PHASE24_CONTRACT_REASONING,
} from './golden-dataset-phase24-contract-reasoning.js';
import { CONTRACT_RECOMMENDATION_URL_REGISTRY } from './contract-recommendation-registry.js';

const EXPECTED_TOTAL = Object.values(CONTRACT_REASONING_CATEGORY_COUNTS).reduce(
  (sum, count) => sum + count,
  0,
);

describe('Golden Dataset Phase 24 Contract Reasoning (SCRUM-861)', () => {
  it('contains exactly 600 reasoning entries', () => {
    expect(EXPECTED_TOTAL).toBe(600);
    expect(GOLDEN_DATASET_PHASE24_CONTRACT_REASONING).toHaveLength(EXPECTED_TOTAL);
  });

  it('matches the Jira reasoning-category distribution', () => {
    const observed = new Map<string, number>();
    for (const entry of GOLDEN_DATASET_PHASE24_CONTRACT_REASONING) {
      const reasoningType = entry.groundTruth.contractReasoningType ?? 'missing';
      observed.set(reasoningType, (observed.get(reasoningType) ?? 0) + 1);
    }

    for (const [reasoningType, expected] of Object.entries(CONTRACT_REASONING_CATEGORY_COUNTS)) {
      expect(observed.get(reasoningType), reasoningType).toBe(expected);
    }
  });

  it('uses unique non-overlapping GD-5100+ IDs', () => {
    const ids = GOLDEN_DATASET_PHASE24_CONTRACT_REASONING.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      const numericId = Number(id.replace('GD-', ''));
      expect(numericId, id).toBeGreaterThanOrEqual(5100);
      expect(numericId, id).toBeLessThan(5700);
    }
  });

  it('has substantive reasoning, concerns, and risk flags on every entry', () => {
    for (const entry of GOLDEN_DATASET_PHASE24_CONTRACT_REASONING) {
      expect(entry.groundTruth.reasoning?.length ?? 0, entry.id).toBeGreaterThan(80);
      expect(entry.groundTruth.concerns?.length ?? 0, entry.id).toBeGreaterThan(0);
      expect(entry.groundTruth.riskFlags?.length ?? 0, entry.id).toBeGreaterThan(0);
    }
  });

  it('validates every recommendation URL against the GME8.3 registry', () => {
    const registryUrls = new Set(CONTRACT_RECOMMENDATION_URL_REGISTRY.map(item => item.url));

    for (const entry of GOLDEN_DATASET_PHASE24_CONTRACT_REASONING) {
      const urls = entry.groundTruth.recommendationUrls ?? [];
      expect(urls.length, entry.id).toBeGreaterThan(0);

      for (const url of urls) {
        expect(registryUrls.has(url), `${entry.id}: ${url}`).toBe(true);
        expect(() => new URL(url), `${entry.id}: ${url}`).not.toThrow();
      }
    }
  });

  it('marks the required 20% human-review sample', () => {
    const reviewSample = GOLDEN_DATASET_PHASE24_CONTRACT_REASONING.filter(
      entry => entry.tags.includes('human-review-sample'),
    );

    expect(CONTRACT_REASONING_HUMAN_REVIEW_SAMPLE_SIZE).toBe(120);
    expect(reviewSample).toHaveLength(CONTRACT_REASONING_HUMAN_REVIEW_SAMPLE_SIZE);
  });

  it('PII-strips all reasoning source text', () => {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/,
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i,
      /\(\d{3}\)\s*\d{3}-\d{4}/,
    ];

    for (const entry of GOLDEN_DATASET_PHASE24_CONTRACT_REASONING) {
      expect(entry.strippedText, entry.id).toContain('REDACTED');
      for (const pattern of piiPatterns) {
        expect(pattern.test(entry.strippedText), entry.id).toBe(false);
      }
    }
  });
});
