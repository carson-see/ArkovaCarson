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
  // CLE-specific fields (Session 10)
  creditHours: z.number().optional(),
  creditType: z.string().optional(),
  barNumber: z.string().optional(),
  activityNumber: z.string().optional(),
  providerName: z.string().optional(),
  approvedBy: z.string().optional(),
  // CHARITY-specific fields (GME-21)
  einNumber: z.string().optional(),
  taxExemptStatus: z.string().optional(),
  governingBody: z.string().optional(),
  // FINANCIAL_ADVISOR-specific fields (GME-21)
  crdNumber: z.string().optional(),
  firmName: z.string().optional(),
  finraRegistration: z.string().optional(),
  seriesLicenses: z.string().optional(),
  // BUSINESS_ENTITY-specific fields (GME-21)
  entityType: z.string().optional(),
  stateOfFormation: z.string().optional(),
  registeredAgent: z.string().optional(),
  goodStandingStatus: z.string().optional(),
  // Smart type suggestion for OTHER (GME-25)
  suggestedType: z.string().optional(),
  // Fraud signals (Session 10)
  fraudSignals: z.array(z.string()).optional(),
  // GRE-01: Sub-type taxonomy
  subType: z.string().optional(),
  // GRE-02: Chain-of-thought reasoning fields
  reasoning: z.string().optional(),
  concerns: z.array(z.string()).optional(),
  issuerVerified: z.boolean().optional(),
  // Gemini structured output emits these; previously caused .strict() to reject ALL responses
  // (root cause of "0% F1" for all eval runs across providers). Captured 2026-04-15.
  confidenceReasoning: z.string().optional(),
  // GME2 v6: 1–2 sentence human-readable summary suitable for customer reports.
  // v6 tuned model always emits this; adding here so .strict() does not reject v6 output.
  description: z.string().max(500).optional(),
}).strict();

/**
 * Schema for extraction request validation (inbound to the extraction endpoint).
 */
export const ExtractionRequestSchema = z.object({
  strippedText: z.string().min(1, 'Stripped text is required').max(50_000, 'Stripped text exceeds 50,000 character limit'),
  credentialType: z.string().min(1, 'Credential type hint is required').max(50, 'Credential type hint too long'),
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
