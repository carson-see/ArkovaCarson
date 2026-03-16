/**
 * Extraction Feedback Service (P8-S6)
 *
 * Stores user corrections to AI suggestions and tracks accuracy per
 * credential type + field. Enables continuous learning by feeding
 * acceptance/rejection signals back into prompt tuning.
 *
 * Constitution 4A: Only PII-stripped metadata is stored (field keys/values).
 * No document bytes, raw OCR, or PII ever reaches this service.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

// =============================================================================
// SCHEMAS
// =============================================================================

export const FeedbackItemSchema = z.object({
  anchorId: z.string().uuid(),
  fingerprint: z.string().length(64),
  credentialType: z.string().min(1),
  fieldKey: z.string().min(1),
  originalValue: z.string().nullable().optional(),
  correctedValue: z.string().nullable().optional(),
  action: z.enum(['accepted', 'rejected', 'edited']),
  originalConfidence: z.number().min(0).max(1).optional(),
  provider: z.string().optional(),
});

export const FeedbackBatchSchema = z.object({
  items: z.array(FeedbackItemSchema).min(1).max(50),
});

export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export interface AccuracyStats {
  credentialType: string;
  fieldKey: string;
  totalSuggestions: number;
  acceptedCount: number;
  rejectedCount: number;
  editedCount: number;
  acceptanceRate: number;
  avgConfidence: number;
}

// =============================================================================
// STORE FEEDBACK
// =============================================================================

/**
 * Store a batch of extraction feedback items.
 * Each item records a user's accept/reject/edit action on an AI-suggested field.
 */
export async function storeExtractionFeedback(
  orgId: string | undefined,
  userId: string,
  items: FeedbackItem[],
): Promise<{ stored: number; errors: number }> {
  let stored = 0;
  let errors = 0;

  for (const item of items) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (db as any).from('extraction_feedback').insert({
        org_id: orgId ?? null,
        user_id: userId,
        anchor_id: item.anchorId,
        fingerprint: item.fingerprint,
        credential_type: item.credentialType,
        field_key: item.fieldKey,
        original_value: item.originalValue ?? null,
        corrected_value: item.correctedValue ?? null,
        action: item.action,
        original_confidence: item.originalConfidence ?? null,
        provider: item.provider ?? null,
      });

      if (error) {
        logger.warn({ error, fieldKey: item.fieldKey }, 'Failed to store feedback item');
        errors++;
      } else {
        stored++;
      }
    } catch (err) {
      logger.warn({ error: err, fieldKey: item.fieldKey }, 'Failed to store feedback item');
      errors++;
    }
  }

  return { stored, errors };
}

// =============================================================================
// GET ACCURACY STATS
// =============================================================================

/**
 * Get extraction accuracy statistics, optionally filtered by credential type and org.
 * Uses the get_extraction_accuracy RPC.
 */
export async function getExtractionAccuracy(
  credentialType?: string,
  orgId?: string,
  days: number = 30,
): Promise<AccuracyStats[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.rpc as any)('get_extraction_accuracy', {
      p_credential_type: credentialType ?? null,
      p_org_id: orgId ?? null,
      p_days: days,
    });

    if (error) {
      logger.error({ error }, 'Failed to get extraction accuracy');
      return [];
    }

    if (!data || !Array.isArray(data)) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.map((row: any) => ({
      credentialType: row.credential_type,
      fieldKey: row.field_key,
      totalSuggestions: Number(row.total_suggestions),
      acceptedCount: Number(row.accepted_count),
      rejectedCount: Number(row.rejected_count),
      editedCount: Number(row.edited_count),
      acceptanceRate: Number(row.acceptance_rate),
      avgConfidence: Number(row.avg_confidence),
    }));
  } catch (err) {
    logger.error({ error: err }, 'Failed to get extraction accuracy');
    return [];
  }
}
