/**
 * Embedding Service (P8-S11)
 *
 * Generates and stores 768-dimensional vector embeddings for credential metadata.
 * Uses IAIProvider.generateEmbedding() — provider-agnostic.
 *
 * Constitution 4A: Only PII-stripped metadata is embedded. Document bytes
 * and raw OCR text never reach this service.
 *
 * Embeddings are stored in `credential_embeddings` table (migration 0060)
 * and searched via `search_credential_embeddings` RPC using cosine similarity.
 */

import type { IAIProvider, EmbeddingResult } from './types.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from './cost-tracker.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/** Metadata fields used to generate embedding text */
export interface EmbeddingMetadata {
  credentialType?: string;
  issuerName?: string;
  recipientIdentifier?: string;
  issuedDate?: string;
  expiryDate?: string;
  fieldOfStudy?: string;
  degreeLevel?: string;
  jurisdiction?: string;
  [key: string]: string | undefined;
}

/** Input for generating and storing a single embedding */
export interface EmbeddingInput {
  anchorId: string;
  orgId: string;
  metadata: EmbeddingMetadata;
  userId?: string;
}

/** Result of a generate-and-store operation */
export interface EmbeddingStoreResult {
  success: boolean;
  model?: string;
  error?: string;
}

/** Result of a batch re-embedding operation */
export interface BatchReEmbedResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ anchorId: string; error: string }>;
}

/**
 * Build a text string from credential metadata for embedding.
 * Concatenates non-empty fields in a structured format for better semantic matching.
 */
export function buildEmbeddingText(metadata: EmbeddingMetadata): string {
  const parts: string[] = [];

  if (metadata.credentialType) parts.push(metadata.credentialType);
  if (metadata.issuerName) parts.push(metadata.issuerName);
  if (metadata.degreeLevel) parts.push(metadata.degreeLevel);
  if (metadata.fieldOfStudy) parts.push(metadata.fieldOfStudy);
  if (metadata.jurisdiction) parts.push(metadata.jurisdiction);
  if (metadata.issuedDate) parts.push(`issued ${metadata.issuedDate}`);
  if (metadata.expiryDate) parts.push(`expires ${metadata.expiryDate}`);

  // Include any additional custom fields
  for (const [key, value] of Object.entries(metadata)) {
    if (
      value &&
      ![
        'credentialType',
        'issuerName',
        'recipientIdentifier',
        'issuedDate',
        'expiryDate',
        'fieldOfStudy',
        'degreeLevel',
        'jurisdiction',
      ].includes(key)
    ) {
      parts.push(value);
    }
  }

  return parts.join(' ');
}

/**
 * Generate an embedding vector for the given text using the AI provider.
 */
export async function generateEmbedding(
  provider: IAIProvider,
  text: string,
): Promise<EmbeddingResult> {
  return provider.generateEmbedding(text);
}

/**
 * Generate an embedding for a credential and store it in the database.
 * Checks and deducts AI credits. Logs the usage event.
 */
export async function generateAndStoreEmbedding(
  provider: IAIProvider,
  input: EmbeddingInput,
): Promise<EmbeddingStoreResult> {
  const { anchorId, orgId, metadata, userId } = input;

  // Check credits
  const credits = await checkAICredits(orgId, userId);
  if (!credits?.hasCredits) {
    return { success: false, error: 'Insufficient AI credits for embedding generation' };
  }

  const text = buildEmbeddingText(metadata);
  const startMs = Date.now();

  try {
    const result = await provider.generateEmbedding(text);
    const durationMs = Date.now() - startMs;

    // Compute source text hash for deduplication
    const encoder = new TextEncoder();
    const hashBuffer = await globalThis.crypto.subtle.digest(
      'SHA-256',
      encoder.encode(text),
    );
    const sourceTextHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Upsert into credential_embeddings (UNIQUE on anchor_id)
    // New table not yet in generated types — use any bypass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: dbError } = await (db as any).from('credential_embeddings').upsert(
      {
        anchor_id: anchorId,
        org_id: orgId,
        embedding: result.embedding,
        model_version: result.model,
        source_text_hash: sourceTextHash,
      },
      { onConflict: 'anchor_id' },
    );

    if (dbError) {
      logger.error({ error: dbError, anchorId }, 'Failed to store embedding');
      return { success: false, error: `Database error: ${dbError.message}` };
    }

    // Deduct credit
    await deductAICredits(orgId, userId, 1);

    // Log usage (non-blocking)
    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'embedding',
      provider: provider.name,
      creditsConsumed: 1,
      durationMs,
      success: true,
    }).catch(() => {});

    return { success: true, model: result.model };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startMs;

    logger.error({ error: err, anchorId }, 'Embedding generation failed');

    // Log failed usage (non-blocking)
    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'embedding',
      provider: provider.name,
      success: false,
      errorMessage,
      durationMs,
    }).catch(() => {});

    return { success: false, error: errorMessage };
  }
}

/**
 * Re-embed multiple credentials in batch.
 * Processes sequentially to respect rate limits.
 */
export async function batchReEmbed(
  provider: IAIProvider,
  orgId: string,
  items: Array<{ anchorId: string; metadata: EmbeddingMetadata }>,
  userId?: string,
): Promise<BatchReEmbedResult> {
  const result: BatchReEmbedResult = {
    total: items.length,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  for (const item of items) {
    const storeResult = await generateAndStoreEmbedding(provider, {
      anchorId: item.anchorId,
      orgId,
      metadata: item.metadata,
      userId,
    });

    if (storeResult.success) {
      result.succeeded++;
    } else {
      result.failed++;
      result.errors.push({
        anchorId: item.anchorId,
        error: storeResult.error ?? 'Unknown error',
      });
    }
  }

  return result;
}
