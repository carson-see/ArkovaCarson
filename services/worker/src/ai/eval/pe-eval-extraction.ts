/**
 * Professional-education eval extraction path (SCRUM-1953 Phase 5 / SCRUM-2188).
 *
 * Why this exists: the generic extraction path (provider.extractMetadata) is
 * structurally unable to score the PE gate fields. Its system prompt never emits
 * deliveryMethod / nasbaStatus / ethicsHours / courseId, and validateFieldsForType
 * strips ethicsHours/courseId for CLE (no CPE allowlist at all). So routing PE
 * entries through it scores 0 on every gated field — a wiring gap, not model
 * quality.
 *
 * This module measures the model's *capability* to read the gated fields off the
 * document: dedicated, category-routed prompts and a raw JSON generate that
 * bypasses the generic system prompt and the per-type field strip. The model is
 * asked for the literal on-document values in camelCase, which is exactly what the
 * golden ground truth records, so scoring (scoring.ts ALL_FIELDS) compares like
 * for like.
 *
 * Eval-only: this does NOT change production extraction. Wiring the production
 * CPE/CLE adapters to emit these fields end-to-end is the separate SCRUM-1854 /
 * SCRUM-1880 work (the adapter prompts + the FIELD_EXTENSIONS allowlist).
 */

import type { IAIProvider } from '../types.js';
import type { GoldenDatasetEntry } from './types.js';
import type { EntryExtractor, EntryExtraction } from './runner.js';
import { stripJsonComments } from '../strip-json-comments.js';
import { buildCourseIdExtractionPrompt } from '../prompts/course-id-extraction-prompt.js';

/**
 * Minimal raw-generate capability a provider must expose to run the PE eval.
 * GeminiProvider implements this; it routes to the tuned Vertex endpoint when
 * GEMINI_TUNED_MODEL is set, or the base Gemini model otherwise.
 */
export interface PeRawModel {
  generateExtractionJson(args: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string; tokensUsed?: number }>;
}

export function supportsPeRawModel(provider: unknown): provider is PeRawModel {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    typeof (provider as PeRawModel).generateExtractionJson === 'function'
  );
}

export const PE_EVAL_SYSTEM_PROMPT = [
  'You extract structured metadata from professional-education credentials (CPE for accountants, CLE for attorneys, and continuing-education course rosters).',
  'Return ONLY a single JSON object. No prose, no markdown fences.',
  'Extract the LITERAL value as printed on the document. Do not normalize to registry codes, do not map to enums, do not abbreviate, and do not invent values.',
  'Use the exact field names requested. Numeric fields (creditHours, ethicsHours) must be JSON numbers, not strings.',
  'If a requested field is not present on the document, set it to null rather than guessing.',
  'Include a "confidence" number between 0 and 1 reflecting overall extraction certainty.',
  'Never include participant, attendee, attorney, or recipient personal information (names, emails, addresses, bar numbers) in the output.',
].join('\n');

/** Numeric fields that must be coerced from string to number after parsing. */
const PE_NUMERIC_FIELDS = new Set(['creditHours', 'ethicsHours']);

function classifyPeEntry(entry: GoldenDatasetEntry): 'cpe' | 'cle' | 'course-id' {
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  if (tags.includes('cpe')) return 'cpe';
  if (tags.includes('cle')) return 'cle';
  return 'course-id';
}

function buildCpeUserPrompt(text: string): string {
  return [
    'Extract CPE (Continuing Professional Education) metadata from this document.',
    'Return JSON with these fields (use null when absent): credentialType, issuerName, issuedDate, fieldOfStudy, accreditingBody, jurisdiction, creditHours, creditType, providerName, approvedBy, activityNumber, courseId, deliveryMethod, nasbaStatus, confidence.',
    'credentialType is "CPE". creditHours is the total CPE credit hours as a number.',
    'deliveryMethod is the verbatim delivery method printed on the certificate (e.g. "Group Internet Based", "QAS Self-Study").',
    'nasbaStatus is the verbatim NASBA registry status word printed on the document (e.g. "Active").',
    'courseId is the verbatim course id / course number / activity number printed on the document.',
    'issuedDate must be ISO YYYY-MM-DD.',
    `Document text: ${text}`,
  ].join('\n');
}

function buildCleUserPrompt(text: string): string {
  return [
    'Extract CLE (Continuing Legal Education) metadata from this document.',
    'Return JSON with these fields (use null when absent): credentialType, issuerName, issuedDate, fieldOfStudy, accreditingBody, jurisdiction, creditHours, ethicsHours, creditType, providerName, approvedBy, activityNumber, courseId, deliveryMethod, confidence.',
    'credentialType is "CLE". creditHours is the total CLE credit hours as a number.',
    'ethicsHours is a first-class separate number: read the dedicated ethics-hours figure printed on the document. Never infer ethicsHours from the total credit hours and never default it to 0 — use null if it is not printed.',
    'jurisdiction: if the document lists multiple states/jurisdictions, return their full names joined by "; " in the order printed.',
    'courseId is the verbatim course id / course number / activity number printed on the document.',
    'issuedDate must be ISO YYYY-MM-DD.',
    `Document text: ${text}`,
  ].join('\n');
}

/** Build the category-routed user prompt for a PE golden entry. */
export function buildPeUserPrompt(entry: GoldenDatasetEntry): string {
  switch (classifyPeEntry(entry)) {
    case 'cpe':
      return buildCpeUserPrompt(entry.strippedText);
    case 'cle':
      return buildCleUserPrompt(entry.strippedText);
    case 'course-id':
      return buildCourseIdExtractionPrompt(entry.strippedText);
  }
}

function stripMarkdownJsonFence(cleaned: string): string {
  if (!cleaned.startsWith('```')) return cleaned;
  const firstLineBreak = cleaned.indexOf('\n');
  const withoutOpeningFence =
    firstLineBreak >= 0 ? cleaned.slice(firstLineBreak + 1) : cleaned.slice(3);
  const trimmed = withoutOpeningFence.trim();
  return trimmed.endsWith('```') ? trimmed.slice(0, -3).trim() : trimmed;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const unfenced = stripMarkdownJsonFence(stripJsonComments(text).trim());
  try {
    return asObject(JSON.parse(unfenced));
  } catch (initialError) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return asObject(JSON.parse(unfenced.slice(start, end + 1)));
    }
    throw initialError;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('PE extraction response was not a JSON object');
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Parse a PE extraction JSON payload into camelCase fields + confidence.
 * Strips JS comments / markdown fences, coerces numeric fields, and drops
 * null/undefined values so absent fields score as missing rather than mismatch.
 */
export function parsePeExtraction(text: string): {
  fields: Record<string, unknown>;
  confidence: number;
} {
  const parsed = parseJsonObject(text);
  const { confidence: rawConfidence, ...rest } = parsed;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === null || value === undefined) continue;
    if (PE_NUMERIC_FIELDS.has(key)) {
      const num = coerceNumber(value);
      if (num !== undefined) fields[key] = num;
      continue;
    }
    fields[key] = value;
  }

  const confidence = coerceNumber(rawConfidence);
  return { fields, confidence: confidence ?? 0.5 };
}

/**
 * Build the EntryExtractor used by run-pe-gates for real providers. Requires the
 * provider to expose generateExtractionJson (GeminiProvider does). Fails loudly
 * otherwise — a silent fallback to the generic path is what produced the 0-F1
 * wiring gap in the first place.
 */
export function createPeEntryExtractor(): EntryExtractor {
  return async (provider: IAIProvider, entry: GoldenDatasetEntry): Promise<EntryExtraction> => {
    if (!supportsPeRawModel(provider)) {
      throw new Error(
        `Provider "${provider?.name ?? 'unknown'}" does not expose generateExtractionJson — ` +
          'the PE eval needs a raw-generate capability that bypasses the generic extraction prompt.',
      );
    }
    const { text, tokensUsed } = await provider.generateExtractionJson({
      systemPrompt: PE_EVAL_SYSTEM_PROMPT,
      userPrompt: buildPeUserPrompt(entry),
    });
    const { fields, confidence } = parsePeExtraction(text);
    return { fields, confidence, tokensUsed };
  };
}
