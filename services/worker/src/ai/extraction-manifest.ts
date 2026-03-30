/**
 * VAI-01: Extraction Manifest — Cryptographic Binding of AI Output
 *
 * Generates a signed manifest that cryptographically binds every AI extraction
 * to its source document hash. The manifest hash is stored on-chain via anchor
 * metadata, creating an immutable provenance chain: Source → AI → Anchor.
 *
 * Manifest = {source_hash, model_id, model_version, extraction_timestamp, extracted_fields, confidence_scores}
 * Hash = SHA-256(canonical JSON of manifest)
 */
import { createHash } from 'crypto';
import type { ExtractedFields } from './types.js';

/** Per-field and overall confidence scores for the extraction. */
export interface ManifestConfidenceScores {
  overall: number;
  grounding?: number;
  fields?: Record<string, number>;
}

/** Input to build an extraction manifest. */
export interface ExtractionManifestInput {
  fingerprint: string;
  modelId: string;
  modelVersion: string;
  extractedFields: ExtractedFields;
  confidenceScores: ManifestConfidenceScores;
  promptVersion?: string;
  extractionTimestamp?: Date;
}

/** The complete extraction manifest with computed hash. */
export interface ExtractionManifest {
  fingerprint: string;
  modelId: string;
  modelVersion: string;
  extractedFields: ExtractedFields;
  confidenceScores: ManifestConfidenceScores;
  promptVersion?: string;
  extractionTimestamp: string; // ISO 8601
  manifestHash: string; // SHA-256 hex
}

/** Fields included in the canonical hash computation. */
interface ManifestHashInput {
  fingerprint: string;
  modelId: string;
  modelVersion: string;
  extractedFields: Record<string, unknown>;
  confidenceScores: Record<string, unknown>;
  extractionTimestamp: string;
}

/**
 * Compute SHA-256 hash of the canonical manifest JSON.
 *
 * Uses sorted keys at all nesting levels to ensure deterministic output
 * regardless of object key insertion order.
 */
export function computeManifestHash(input: ManifestHashInput): string {
  const deepSorted = deepSortKeys(input);
  const canonical = JSON.stringify(deepSorted);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Recursively sort object keys for canonical JSON representation. */
function deepSortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(deepSortKeys);
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

/**
 * Build a cryptographic extraction manifest from extraction results.
 *
 * The manifest captures the complete provenance of an AI extraction:
 * - What document was processed (fingerprint)
 * - Which model processed it (modelId + modelVersion)
 * - What was extracted (extractedFields)
 * - How confident the model was (confidenceScores)
 * - When it happened (extractionTimestamp)
 *
 * The manifest hash is the SHA-256 of the canonical JSON representation,
 * suitable for embedding in anchor metadata and on-chain OP_RETURN data.
 */
export function buildExtractionManifest(
  input: ExtractionManifestInput,
): ExtractionManifest {
  const extractionTimestamp = (
    input.extractionTimestamp ?? new Date()
  ).toISOString();

  const hashInput: ManifestHashInput = {
    fingerprint: input.fingerprint,
    modelId: input.modelId,
    modelVersion: input.modelVersion,
    extractedFields: input.extractedFields as unknown as Record<string, unknown>,
    confidenceScores: input.confidenceScores as unknown as Record<string, unknown>,
    extractionTimestamp,
  };

  const manifestHash = computeManifestHash(hashInput);

  return {
    fingerprint: input.fingerprint,
    modelId: input.modelId,
    modelVersion: input.modelVersion,
    extractedFields: input.extractedFields,
    confidenceScores: input.confidenceScores,
    promptVersion: input.promptVersion,
    extractionTimestamp,
    manifestHash,
  };
}
