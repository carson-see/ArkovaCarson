/**
 * GME-14: Structured Output Schema Validation
 *
 * Converts Zod schemas to Gemini-compatible JSON Schemas for native
 * structured output enforcement. When passed as `responseSchema` in
 * the Gemini API's generationConfig, the model is forced to produce
 * output conforming to the schema — reducing parse failures.
 *
 * Gemini uses uppercase type names: STRING, NUMBER, OBJECT, ARRAY, BOOLEAN.
 * Reference: https://ai.google.dev/gemini-api/docs/structured-output
 */

import { z } from 'zod';
import { ExtractedFieldsSchema } from './schemas.js';

/** Gemini-compatible JSON Schema types (uppercase) */
type GeminiSchemaType = 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT';

export interface GeminiSchemaProperty {
  type: GeminiSchemaType;
  description?: string;
  items?: GeminiSchemaProperty;
  properties?: Record<string, GeminiSchemaProperty>;
  required?: string[];
  enum?: string[];
}

export interface GeminiSchema {
  type: 'OBJECT';
  properties: Record<string, GeminiSchemaProperty>;
  required?: string[];
}

/**
 * Map a Zod type to a Gemini schema type.
 */
function zodTypeToGemini(zodType: z.ZodTypeAny): GeminiSchemaProperty {
  // Unwrap optionals
  if (zodType instanceof z.ZodOptional) {
    return zodTypeToGemini(zodType.unwrap());
  }

  // Unwrap defaults
  if (zodType instanceof z.ZodDefault) {
    return zodTypeToGemini(zodType._def.innerType);
  }

  if (zodType instanceof z.ZodString) {
    return { type: 'STRING' };
  }

  if (zodType instanceof z.ZodNumber) {
    return { type: 'NUMBER' };
  }

  if (zodType instanceof z.ZodBoolean) {
    return { type: 'BOOLEAN' };
  }

  if (zodType instanceof z.ZodArray) {
    return {
      type: 'ARRAY',
      items: zodTypeToGemini(zodType.element),
    };
  }

  if (zodType instanceof z.ZodObject) {
    return zodToGeminiSchema(zodType) as GeminiSchemaProperty;
  }

  if (zodType instanceof z.ZodEnum) {
    return { type: 'STRING', enum: zodType._def.values };
  }

  // Fallback: treat as string
  return { type: 'STRING' };
}

/**
 * Convert a Zod object schema to a Gemini-compatible JSON Schema.
 *
 * Gemini's structured output requires uppercase type names and a specific
 * format. This function handles the conversion from Zod's schema format.
 */
export function zodToGeminiSchema(schema: z.ZodObject<z.ZodRawShape>): GeminiSchema {
  const shape = schema.shape;
  const properties: Record<string, GeminiSchemaProperty> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value as z.ZodTypeAny;
    properties[key] = zodTypeToGemini(zodValue);

    // Check if the field is required (not optional)
    if (!(zodValue instanceof z.ZodOptional)) {
      required.push(key);
    }
  }

  return {
    type: 'OBJECT',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Get the Gemini response schema for extraction calls.
 *
 * This extends ExtractedFieldsSchema with the `confidence` field that
 * the extraction prompt asks for but isn't in the Zod schema
 * (it's parsed separately in gemini.ts).
 */
export function getExtractionResponseSchema(): GeminiSchema {
  const baseSchema = zodToGeminiSchema(ExtractedFieldsSchema);

  // Add confidence field (extracted separately in gemini.ts but part of AI output)
  baseSchema.properties.confidence = { type: 'NUMBER' };

  return baseSchema;
}
