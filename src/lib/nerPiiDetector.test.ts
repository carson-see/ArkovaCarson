/**
 * NER PII Detector Tests (Phase 4)
 *
 * Tests entity merging, redaction, and pipeline behavior.
 * Mocks @huggingface/transformers since we can't load models in CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redactNEREntities, type NEREntity } from './nerPiiDetector';

// We test the exported pure functions directly.
// detectPIIWithNER requires the actual model, so we test its integration
// through the enhanced stripper tests with mocks.

describe('nerPiiDetector', () => {
  describe('redactNEREntities', () => {
    it('redacts PERSON entities', () => {
      const text = 'John Smith received a degree from MIT';
      const entities: NEREntity[] = [
        { text: 'John Smith', type: 'PERSON', score: 0.95, start: 0, end: 10 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('[PERSON_REDACTED] received a degree from MIT');
    });

    it('redacts LOCATION entities', () => {
      const text = 'Licensed in New York State';
      const entities: NEREntity[] = [
        { text: 'New York State', type: 'LOCATION', score: 0.92, start: 12, end: 26 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('Licensed in [LOCATION_REDACTED]');
    });

    it('redacts ORGANIZATION entities', () => {
      const text = 'Issued by Harvard University on 2025-01-15';
      const entities: NEREntity[] = [
        { text: 'Harvard University', type: 'ORGANIZATION', score: 0.98, start: 10, end: 28 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('Issued by [ORG_REDACTED] on 2025-01-15');
    });

    it('redacts MISC entities', () => {
      const text = 'The HIPAA regulation requires compliance';
      const entities: NEREntity[] = [
        { text: 'HIPAA', type: 'MISC', score: 0.85, start: 4, end: 9 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('The [ENTITY_REDACTED] regulation requires compliance');
    });

    it('handles multiple entities in correct order', () => {
      const text = 'Jane Doe works at Google in California';
      const entities: NEREntity[] = [
        { text: 'Jane Doe', type: 'PERSON', score: 0.95, start: 0, end: 8 },
        { text: 'Google', type: 'ORGANIZATION', score: 0.97, start: 18, end: 24 },
        { text: 'California', type: 'LOCATION', score: 0.93, start: 28, end: 38 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('[PERSON_REDACTED] works at [ORG_REDACTED] in [LOCATION_REDACTED]');
    });

    it('handles empty entity list', () => {
      const text = 'No entities here';
      const result = redactNEREntities(text, []);
      expect(result).toBe('No entities here');
    });

    it('handles adjacent entities', () => {
      const text = 'JohnDoe';
      const entities: NEREntity[] = [
        { text: 'John', type: 'PERSON', score: 0.9, start: 0, end: 4 },
        { text: 'Doe', type: 'PERSON', score: 0.85, start: 4, end: 7 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('[PERSON_REDACTED][PERSON_REDACTED]');
    });

    it('preserves text between entities', () => {
      const text = 'From: Alice To: Bob Subject: Report';
      const entities: NEREntity[] = [
        { text: 'Alice', type: 'PERSON', score: 0.9, start: 6, end: 11 },
        { text: 'Bob', type: 'PERSON', score: 0.88, start: 16, end: 19 },
      ];
      const result = redactNEREntities(text, entities);
      expect(result).toBe('From: [PERSON_REDACTED] To: [PERSON_REDACTED] Subject: Report');
    });
  });
});
