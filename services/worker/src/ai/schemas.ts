/**
 * AI Extraction Zod Schemas (P8-S1)
 *
 * Zod schemas for validating AI extraction requests and responses.
 * Used by all IAIProvider implementations to ensure type safety.
 */

import { z } from 'zod';

/**
 * Schema for the structured fields returned by AI extraction.
 * All fields are optional — the AI may not be able to extract everything.
 */
export const ExtractedFieldsSchema = z.object({
  credentialType: z.string().optional(),
  issuerName: z.string().optional(),
  recipientIdentifier: z.string().optional(),
  issuedDate: z.string().optional(),
  expiryDate: z.string().optional(),
  fieldOfStudy: z.string().optional(),
  degreeLevel: z.string().optional(),
  licenseNumber: z.string().optional(),
  accreditingBody: z.string().optional(),
  jurisdiction: z.string().optional(),
}).strict();

/**
 * Schema for extraction request validation (inbound to the extraction endpoint).
 */
export const ExtractionRequestSchema = z.object({
  strippedText: z.string().min(1, 'Stripped text is required'),
  credentialType: z.string().min(1, 'Credential type hint is required'),
  fingerprint: z.string().length(64, 'Fingerprint must be a 64-char SHA-256 hex string'),
  issuerHint: z.string().max(200).optional(),
});

/**
 * Schema for the full extraction result (outbound from the extraction endpoint).
 */
export const ExtractionResultSchema = z.object({
  fields: ExtractedFieldsSchema,
  confidence: z.number().min(0).max(1),
  provider: z.string(),
  tokensUsed: z.number().optional(),
});

export type ValidatedExtractionRequest = z.infer<typeof ExtractionRequestSchema>;
