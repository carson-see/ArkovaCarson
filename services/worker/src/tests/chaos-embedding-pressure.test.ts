/**
 * QA-CHAOS-04: Embedding Memory Pressure Test
 *
 * Validates that the embedding pipeline handles memory pressure gracefully:
 * - Large batch operations don't accumulate unbounded memory
 * - buildEmbeddingText handles edge cases (empty metadata, large fields)
 * - Rate limit store and idempotency store have bounded growth
 * - Sequential batch processing prevents concurrent memory spikes
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn().mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { credits_remaining: 9999 }, error: null }),
        }),
      }),
    }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { buildEmbeddingText, type EmbeddingMetadata } from '../ai/embeddings.js';
import { getRateLimitStoreSize } from '../utils/rateLimit.js';
import { getIdempotencyStoreSize } from '../middleware/idempotency.js';

describe('QA-CHAOS-04: Embedding Memory Pressure', () => {
  describe('buildEmbeddingText edge cases', () => {
    it('handles empty metadata gracefully', () => {
      const text = buildEmbeddingText({});
      expect(text).toBe('');
    });

    it('handles metadata with only undefined values', () => {
      const text = buildEmbeddingText({
        credentialType: undefined,
        issuerName: undefined,
      });
      expect(text).toBe('');
    });

    it('handles very long field values without crashing', () => {
      const longValue = 'A'.repeat(100_000);
      const text = buildEmbeddingText({
        credentialType: 'DEGREE',
        issuerName: longValue,
      });
      expect(text.length).toBeGreaterThan(100_000);
      expect(text).toContain('DEGREE');
    });

    it('handles metadata with many custom fields', () => {
      const metadata: EmbeddingMetadata = {};
      for (let i = 0; i < 500; i++) {
        metadata[`customField${i}`] = `value${i}`;
      }
      const text = buildEmbeddingText(metadata);
      expect(text).toContain('value0');
      expect(text).toContain('value499');
    });

    it('handles special characters in metadata', () => {
      const text = buildEmbeddingText({
        credentialType: 'DEGREE',
        issuerName: 'Universit\u00e4t Z\u00fcrich',
        fieldOfStudy: '\u8ba1\u7b97\u673a\u79d1\u5b66', // Chinese characters
      });
      expect(text).toContain('Z\u00fcrich');
      expect(text).toContain('\u8ba1\u7b97\u673a');
    });

    it('excludes recipientIdentifier (PII field)', () => {
      const text = buildEmbeddingText({
        credentialType: 'DEGREE',
        recipientIdentifier: 'john.doe@example.com',
        issuerName: 'MIT',
      });
      // recipientIdentifier should not be in the text
      expect(text).not.toContain('john.doe@example.com');
      expect(text).toContain('DEGREE');
      expect(text).toContain('MIT');
    });

    it('produces consistent text ordering', () => {
      const metadata: EmbeddingMetadata = {
        credentialType: 'LICENSE',
        issuerName: 'State Bar',
        jurisdiction: 'California',
        issuedDate: '2024-01-15',
      };
      const text1 = buildEmbeddingText(metadata);
      const text2 = buildEmbeddingText({ ...metadata });
      expect(text1).toBe(text2);
    });
  });

  describe('bounded store growth', () => {
    it('rate limit store starts at bounded size', () => {
      const size = getRateLimitStoreSize();
      // Should be a finite number (may have some entries from other test setup)
      expect(size).toBeGreaterThanOrEqual(0);
      expect(size).toBeLessThan(500_000);
    });

    it('idempotency store starts empty or bounded', () => {
      const size = getIdempotencyStoreSize();
      expect(size).toBeGreaterThanOrEqual(0);
      expect(size).toBeLessThan(100_000);
    });
  });

  describe('batch embedding text generation under load', () => {
    it('generates 1000 embedding texts without memory issues', () => {
      const startMem = process.memoryUsage().heapUsed;

      const texts: string[] = [];
      for (let i = 0; i < 1000; i++) {
        texts.push(
          buildEmbeddingText({
            credentialType: ['DEGREE', 'LICENSE', 'CERTIFICATE'][i % 3],
            issuerName: `University ${i}`,
            fieldOfStudy: `Field ${i}`,
            jurisdiction: `State ${i % 50}`,
            issuedDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-15`,
          }),
        );
      }

      const endMem = process.memoryUsage().heapUsed;
      const memDeltaMb = (endMem - startMem) / 1024 / 1024;

      expect(texts).toHaveLength(1000);
      // Each text is ~50-100 chars, 1000 texts should be well under 10MB
      expect(memDeltaMb).toBeLessThan(50);
    });

    it('handles 100 concurrent metadata objects with large custom fields', () => {
      const results = Array.from({ length: 100 }, (_, i) => {
        const metadata: EmbeddingMetadata = {
          credentialType: 'DEGREE',
          issuerName: `Institution ${i}`,
        };
        // Add 20 custom fields per entry
        for (let j = 0; j < 20; j++) {
          metadata[`custom_${j}`] = `Custom value for field ${j} of entry ${i}`;
        }
        return buildEmbeddingText(metadata);
      });

      expect(results).toHaveLength(100);
      // All texts should be non-empty
      for (const text of results) {
        expect(text.length).toBeGreaterThan(0);
      }
    });
  });
});
