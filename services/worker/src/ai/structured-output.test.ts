/**
 * GME-14: Structured Output Schema Validation Tests
 *
 * Verifies that Zod schemas are converted to Gemini-compatible JSON Schemas
 * and passed to the Gemini API for native schema enforcement.
 */

import { describe, it, expect } from 'vitest';
import { zodToGeminiSchema, getExtractionResponseSchema } from './structured-output.js';
import { ExtractedFieldsSchema } from './schemas.js';
import { z } from 'zod';

describe('GME-14: Structured Output Schema Validation', () => {
  describe('zodToGeminiSchema', () => {
    it('converts a simple Zod object to JSON Schema', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = zodToGeminiSchema(schema);

      expect(result.type).toBe('OBJECT');
      expect(result.properties).toHaveProperty('name');
      expect(result.properties).toHaveProperty('age');
      expect(result.properties.name.type).toBe('STRING');
      expect(result.properties.age.type).toBe('NUMBER');
    });

    it('handles optional fields correctly', () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });

      const result = zodToGeminiSchema(schema);

      // Optional fields should not be in required array
      expect(result.required).toContain('required');
      expect(result.required).not.toContain('optional');
    });

    it('handles array fields', () => {
      const schema = z.object({
        tags: z.array(z.string()),
      });

      const result = zodToGeminiSchema(schema);

      expect(result.properties.tags.type).toBe('ARRAY');
      expect(result.properties.tags.items!.type).toBe('STRING');
    });

    it('handles number fields', () => {
      const schema = z.object({
        count: z.number(),
      });

      const result = zodToGeminiSchema(schema);
      expect(result.properties.count.type).toBe('NUMBER');
    });
  });

  describe('getExtractionResponseSchema', () => {
    it('returns a valid Gemini schema for extraction', () => {
      const schema = getExtractionResponseSchema();

      expect(schema.type).toBe('OBJECT');
      // Must include confidence field (added on top of ExtractedFieldsSchema)
      expect(schema.properties).toHaveProperty('confidence');
      expect(schema.properties.confidence.type).toBe('NUMBER');
      // Must include credentialType
      expect(schema.properties).toHaveProperty('credentialType');
      expect(schema.properties.credentialType.type).toBe('STRING');
    });

    it('includes all ExtractedFields properties', () => {
      const schema = getExtractionResponseSchema();
      const zodKeys = Object.keys(ExtractedFieldsSchema.shape);

      for (const key of zodKeys) {
        expect(
          schema.properties,
          `Missing field: ${key}`,
        ).toHaveProperty(key);
      }
    });

    it('includes fraudSignals as array of strings', () => {
      const schema = getExtractionResponseSchema();
      expect(schema.properties.fraudSignals.type).toBe('ARRAY');
      expect(schema.properties.fraudSignals.items!.type).toBe('STRING');
    });
  });
});
