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

import { z } from 'zod';
import type { IAIProvider, EmbeddingResult, EmbeddingTaskType } from './types.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from './cost-tracker.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const MAX_NATIVE_EMBEDDING_BATCH_SIZE = 250;

const CredentialEmbeddingRowSchema = z.object({
  anchor_id: z.string().min(1),
  org_id: z.string().min(1),
  embedding: z.array(z.number().refine(Number.isFinite, 'Embedding values must be finite')).min(1),
  model_version: z.string().min(1),
  source_text_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const CredentialEmbeddingRowsSchema = z.array(CredentialEmbeddingRowSchema).min(1);
const CredentialEmbeddingRollbackRowsSchema = z.array(CredentialEmbeddingRowSchema);

type CredentialEmbeddingRow = z.infer<typeof CredentialEmbeddingRowSchema>;

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

/**
 * Machine-readable reason an embedding failed (B1, SCRUM-4939 follow-up).
 *
 * WHY A CODE AND NOT THE MESSAGE. `api/v1/ai-embed.ts` used to pick the HTTP
 * status by asking whether the failure MESSAGE contained the substring
 * "credit":
 *
 *     const status = result.error?.includes('credit') ? 402 : 500;
 *
 * Every credit failure in this module says "credit" — including the 55P03 lock
 * timeout `deduct_ai_credits` raises under contention (migration 0483) and a
 * plain RPC outage. Both answered `402 insufficient_credits`, i.e. told a
 * customer who HAS credits to go buy more, for a failure that is ours and
 * retryable. Meanwhile any provider error whose text happened to contain
 * "credential" — most of them, on this surface — matched the same substring.
 *
 * The distinction the caller actually needs is "the customer is out of credit"
 * (402, the customer acts) versus "the credit system did not answer" (503, we
 * act), and that is a property of the failure, not of its wording.
 */
export type EmbeddingFailureCode =
  /** The org's metered balance is genuinely exhausted. The customer must act. */
  | 'insufficient_credits'
  /** `check_ai_credits` did not answer (outage, connection loss). Retryable. */
  | 'credit_check_unavailable'
  /**
   * `deduct_ai_credits` did not answer, or answered falsy for a reason that is
   * not exhaustion — 55P03 lock timeout, dead connection, RPC missing. NOTHING
   * was charged and nothing stored is kept. Retryable, and ours.
   */
  | 'credit_debit_unavailable'
  /** Persisting the embedding row failed. */
  | 'database_error'
  /** The same anchor appeared twice in one batch. */
  | 'duplicate_anchor_id'
  /** The provider call or row validation failed. */
  | 'embedding_failed';

/** Result of a generate-and-store operation */
export type EmbeddingStoreResult =
  | { success: true; model: string; code?: undefined; error?: undefined }
  | { success: false; code: EmbeddingFailureCode; error: string; model?: undefined };

/** One failed row in a batch re-embedding operation */
export interface BatchReEmbedError {
  anchorId: string;
  error: string;
  code: EmbeddingFailureCode;
}

/** Result of a batch re-embedding operation */
export interface BatchReEmbedResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: BatchReEmbedError[];
}

/**
 * Thrown when the AI-credit DEBIT could not be confirmed — the 55P03 lock
 * timeout, a dead connection, or `deductAICredits` answering falsy for any
 * reason other than exhaustion (which this module rules out before the debit
 * by returning early on a null balance).
 *
 * It exists so the classification survives the `catch` that runs the embedding
 * rollback: without a typed error the only thing left at the catch site is the
 * message, which is exactly the signal B1 removed from the route.
 */
export class CreditDebitUnavailableError extends Error {
  readonly code = 'credit_debit_unavailable' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CreditDebitUnavailableError';
  }
}

/**
 * Thrown when the AI-credit PRE-CHECK did not answer. Distinct from exhaustion:
 * a rejected `checkAICredits` says nothing about the balance.
 */
export class CreditCheckUnavailableError extends Error {
  readonly code = 'credit_check_unavailable' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CreditCheckUnavailableError';
  }
}

/** Classify a thrown value for the result's `code`. */
function embeddingFailureCode(err: unknown): EmbeddingFailureCode {
  if (err instanceof CreditDebitUnavailableError) return 'credit_debit_unavailable';
  if (err instanceof CreditCheckUnavailableError) return 'credit_check_unavailable';
  return 'embedding_failed';
}

interface PreparedEmbeddingItem {
  anchorId: string;
  text: string;
}

function formatCredentialEmbeddingValidationError(error: z.ZodError): string {
  const detail = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
  return `Invalid credential embedding row: ${detail}`;
}

function validateCredentialEmbeddingRow(row: CredentialEmbeddingRow): CredentialEmbeddingRow {
  const parsed = CredentialEmbeddingRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(formatCredentialEmbeddingValidationError(parsed.error));
  }
  return parsed.data;
}

function validateCredentialEmbeddingRows(rows: CredentialEmbeddingRow[]): CredentialEmbeddingRow[] {
  const parsed = CredentialEmbeddingRowsSchema.safeParse(rows);
  if (!parsed.success) {
    throw new Error(formatCredentialEmbeddingValidationError(parsed.error));
  }
  return parsed.data;
}

function databaseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

async function readExistingCredentialEmbeddingRows(
  anchorIds: string[],
): Promise<CredentialEmbeddingRow[]> {
  if (anchorIds.length === 0) return [];

  // Generated types do not include credential_embeddings yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('credential_embeddings')
    .select('anchor_id, org_id, embedding, model_version, source_text_hash')
    .in('anchor_id', anchorIds);

  if (error) {
    throw new Error(`Database error: ${error.message}`);
  }

  const parsed = CredentialEmbeddingRollbackRowsSchema.safeParse(data ?? []);
  if (!parsed.success) {
    throw new Error(formatCredentialEmbeddingValidationError(parsed.error));
  }

  return parsed.data;
}

async function rollbackStoredCredentialEmbeddings(
  anchorIds: string[],
  previousRows: CredentialEmbeddingRow[],
): Promise<void> {
  if (anchorIds.length === 0) return;

  const previousAnchorIds = new Set(previousRows.map((row) => row.anchor_id));
  const insertedAnchorIds = anchorIds.filter((anchorId) => !previousAnchorIds.has(anchorId));

  if (insertedAnchorIds.length > 0) {
    // Generated types do not include credential_embeddings yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('credential_embeddings')
      .delete()
      .in('anchor_id', insertedAnchorIds);

    if (error) {
      const message = [
        'Failed to delete new credential embeddings during rollback',
        `anchorIds=${insertedAnchorIds.join(',')}`,
        `error=${databaseErrorMessage(error)}`,
      ].join(': ');
      logger.error(
        { error, anchorIds: insertedAnchorIds },
        message,
      );
      throw new Error(message);
    }
  }

  if (previousRows.length > 0) {
    // Generated types do not include credential_embeddings yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('credential_embeddings').upsert(
      previousRows,
      { onConflict: 'anchor_id' },
    );

    if (error) {
      const restoredAnchorIds = previousRows.map((row) => row.anchor_id);
      const message = [
        'Failed to restore previous credential embeddings during rollback',
        `anchorIds=${restoredAnchorIds.join(',')}`,
        `error=${databaseErrorMessage(error)}`,
      ].join(': ');
      logger.error(
        { error, anchorIds: restoredAnchorIds },
        message,
      );
      throw new Error(message);
    }
  }

  logger.warn(
    {
      insertedAnchorIds,
      restoredAnchorIds: previousRows.map((row) => row.anchor_id),
    },
    'Rolled back stored credential embeddings after credit failure',
  );
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
 * taskType optimizes the embedding space — use RETRIEVAL_DOCUMENT for storage,
 * RETRIEVAL_QUERY for search queries, SEMANTIC_SIMILARITY for matching.
 */
export async function generateEmbedding(
  provider: IAIProvider,
  text: string,
  taskType?: EmbeddingTaskType,
): Promise<EmbeddingResult> {
  return provider.generateEmbedding(text, taskType);
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

  // Check credits.
  //
  // NOTE, stated rather than silently assumed: `checkAICredits` returns null
  // BOTH for "no balance row" and for its own RPC failure, so this branch
  // cannot today tell exhaustion from an unreachable check. It is classified
  // as exhaustion because that is the behaviour this path has always had and
  // narrowing it means changing `checkAICredits`'s contract for every caller.
  // The debit below — the failure B1 is about — IS distinguished.
  const credits = await checkAICredits(orgId, userId);
  if (!credits?.hasCredits) {
    return {
      success: false,
      code: 'insufficient_credits',
      error: 'Insufficient AI credits for embedding generation',
    };
  }

  const text = buildEmbeddingText(metadata);
  const startMs = Date.now();

  try {
    const result = await provider.generateEmbedding(text, 'RETRIEVAL_DOCUMENT');
    const durationMs = Date.now() - startMs;

    // Compute source text hash for deduplication
    const sourceTextHash = await sha256Hex(text);
    const row = validateCredentialEmbeddingRow({
      anchor_id: anchorId,
      org_id: orgId,
      embedding: result.embedding,
      model_version: result.model,
      source_text_hash: sourceTextHash,
    });
    const rollbackRows = await readExistingCredentialEmbeddingRows([anchorId]);

    // Upsert into credential_embeddings (UNIQUE on anchor_id)
    // New table not yet in generated types — use any bypass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: dbError } = await (db as any).from('credential_embeddings').upsert(
      row,
      { onConflict: 'anchor_id' },
    );

    if (dbError) {
      logger.error({ error: dbError, anchorId }, 'Failed to store embedding');
      return {
        success: false,
        code: 'database_error',
        error: `Database error: ${dbError.message}`,
      };
    }

    // Deduct credit.
    //
    // `deductAICredits` never throws — it returns `false` for every failure,
    // including a 55P03 lock timeout from `deduct_ai_credits`'s
    // `SELECT … FOR UPDATE` (migration 0483). A falsy return therefore has to
    // be converted into a throw here or it sails past the rollback below and
    // leaves a STORED embedding that was never charged for: a hollow success,
    // the same defect class ai-extract.ts closed in SCRUM-3502.
    //
    // No unmetered/beta ambiguity applies: this function already returned above
    // when `checkAICredits` came back null, so the org has a finite metered
    // balance here and a falsy debit can only mean "not charged".
    //
    // B1: the throw is TYPED. Everything that leaves this block is a
    // `CreditDebitUnavailableError` — including a rollback that itself failed,
    // which is a worse version of the same infrastructure failure — so the
    // outer catch can classify it without reading the message.
    try {
      const debited = await deductAICredits(orgId, userId, 1);
      if (!debited) {
        throw new CreditDebitUnavailableError(
          'AI credit debit failed — refusing to keep an uncharged embedding',
        );
      }
    } catch (creditError) {
      try {
        await rollbackStoredCredentialEmbeddings([anchorId], rollbackRows);
      } catch (rollbackError) {
        throw new CreditDebitUnavailableError(databaseErrorMessage(rollbackError), {
          cause: rollbackError,
        });
      }
      throw creditError instanceof CreditDebitUnavailableError
        ? creditError
        : new CreditDebitUnavailableError(databaseErrorMessage(creditError), {
          cause: creditError,
        });
    }

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

    return { success: false, code: embeddingFailureCode(err), error: errorMessage };
  }
}

async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(text),
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Re-embed multiple credentials in batch.
 * Uses provider-native batching when available; otherwise falls back to the
 * legacy sequential path to preserve compatibility with non-batch providers.
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

  if (items.length === 0) {
    return result;
  }

  if (provider.generateEmbeddings) {
    return batchReEmbedNative(provider, orgId, items, userId);
  }

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
        error: storeResult.error,
        code: storeResult.code,
      });
    }
  }

  return result;
}

async function batchReEmbedNative(
  provider: IAIProvider,
  orgId: string,
  items: Array<{ anchorId: string; metadata: EmbeddingMetadata }>,
  userId?: string,
): Promise<BatchReEmbedResult> {
  const prepared = items.map((item): PreparedEmbeddingItem => ({
    anchorId: item.anchorId,
    text: buildEmbeddingText(item.metadata),
  }));
  const result: BatchReEmbedResult = {
    total: items.length,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  const anchorIdCounts = new Map<string, number>();
  for (const item of prepared) {
    anchorIdCounts.set(item.anchorId, (anchorIdCounts.get(item.anchorId) ?? 0) + 1);
  }
  if ([...anchorIdCounts.values()].some((count) => count > 1)) {
    result.failed = items.length;
    result.errors = items.map((item) => ({
      anchorId: item.anchorId,
      error: 'Duplicate anchorId in batch',
      code: 'duplicate_anchor_id',
    }));
    return result;
  }

  let credits: Awaited<ReturnType<typeof checkAICredits>>;
  try {
    credits = await checkAICredits(orgId, userId);
  } catch (err) {
    // B1: a REJECTED pre-check says nothing about the balance — the credit
    // system did not answer. That is ours and retryable (503), never a 402.
    const errorMessage = err instanceof Error ? err.message : String(err);
    result.failed = items.length;
    result.errors = items.map((item) => ({
      anchorId: item.anchorId,
      error: errorMessage || 'Insufficient AI credits for embedding batch',
      code: 'credit_check_unavailable',
    }));
    return result;
  }
  if (!credits?.hasCredits || credits.remaining < items.length) {
    // See the note in `generateAndStoreEmbedding`: a null balance is not
    // distinguished from exhaustion here, and narrowing that means changing
    // `checkAICredits`'s contract for every caller.
    result.failed = items.length;
    result.errors = items.map((item) => ({
      anchorId: item.anchorId,
      error: 'Insufficient AI credits for embedding batch',
      code: 'insufficient_credits',
    }));
    return result;
  }

  const startMs = Date.now();

  try {
    const embeddings: EmbeddingResult[] = [];
    for (let i = 0; i < prepared.length; i += MAX_NATIVE_EMBEDDING_BATCH_SIZE) {
      const chunk = prepared.slice(i, i + MAX_NATIVE_EMBEDDING_BATCH_SIZE);
      const embeddingResult = await provider.generateEmbeddings!(
        chunk.map((item) => ({ text: item.text })),
        'RETRIEVAL_DOCUMENT',
      );

      if (embeddingResult.embeddings.length !== chunk.length) {
        throw new Error('Batch embedding result count did not match input count');
      }

      embeddings.push(...embeddingResult.embeddings);
    }
    const durationMs = Date.now() - startMs;

    const rows = validateCredentialEmbeddingRows(await Promise.all(prepared.map(async (item, index) => ({
      anchor_id: item.anchorId,
      org_id: orgId,
      embedding: embeddings[index].embedding,
      model_version: embeddings[index].model,
      source_text_hash: await sha256Hex(item.text),
    }))));
    const rollbackRows = await readExistingCredentialEmbeddingRows(
      items.map((item) => item.anchorId),
    );

    // New table not yet in generated types — use any bypass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: dbError } = await (db as any).from('credential_embeddings').upsert(
      rows,
      { onConflict: 'anchor_id' },
    );

    if (dbError) {
      result.failed = items.length;
      result.errors = items.map((item) => ({
        anchorId: item.anchorId,
        error: `Database error: ${dbError.message}`,
        code: 'database_error',
      }));
      logger.error({ error: dbError, count: items.length }, 'Failed to store batch embeddings');
      return result;
    }

    // Fail CLOSED on a falsy debit exactly as the single-item path above does:
    // `deductAICredits` returns `false` (never throws) on a 55P03 lock timeout,
    // and keeping `items.length` stored embeddings that were never charged for
    // is a hollow success. The batch balance was already verified finite and
    // sufficient before the provider call.
    //
    // B1: typed, exactly as the single-item path — everything that leaves this
    // block is a `CreditDebitUnavailableError`, so the outer catch classifies
    // it without reading the message.
    try {
      const debited = await deductAICredits(orgId, userId, items.length);
      if (!debited) {
        throw new CreditDebitUnavailableError(
          'AI credit debit failed — refusing to keep uncharged embeddings',
        );
      }
    } catch (creditError) {
      try {
        await rollbackStoredCredentialEmbeddings(
          items.map((item) => item.anchorId),
          rollbackRows,
        );
      } catch (rollbackError) {
        throw new CreditDebitUnavailableError(databaseErrorMessage(rollbackError), {
          cause: rollbackError,
        });
      }
      throw creditError instanceof CreditDebitUnavailableError
        ? creditError
        : new CreditDebitUnavailableError(databaseErrorMessage(creditError), {
          cause: creditError,
        });
    }

    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'embedding',
      provider: provider.name,
      creditsConsumed: items.length,
      durationMs,
      success: true,
    }).catch(() => {});

    result.succeeded = items.length;
    return result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startMs;

    logger.error({ error: err, count: items.length }, 'Batch embedding generation failed');

    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'embedding',
      provider: provider.name,
      success: false,
      errorMessage,
      durationMs,
    }).catch(() => {});

    const code = embeddingFailureCode(err);
    result.failed = items.length;
    result.errors = items.map((item) => ({
      anchorId: item.anchorId,
      error: errorMessage,
      code,
    }));
    return result;
  }
}
