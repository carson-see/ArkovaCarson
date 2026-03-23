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
import { callRpc } from '../utils/rpc.js';
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
    const { data, error } = await callRpc(db, 'get_extraction_accuracy', {
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

// =============================================================================
// FEEDBACK LOOP ANALYSIS
// =============================================================================

/** A weak field identified from feedback data */
export interface WeakFieldReport {
  credentialType: string;
  fieldKey: string;
  rejectionRate: number;
  editRate: number;
  totalFeedback: number;
  commonCorrections: Array<{ original: string; corrected: string; count: number }>;
  suggestion: string;
}

/** Overall feedback analysis report */
export interface FeedbackAnalysisReport {
  analyzedAt: string;
  totalFeedbackItems: number;
  weakFields: WeakFieldReport[];
  overallAcceptanceRate: number;
  promptImprovementSuggestions: string[];
}

/**
 * Analyze feedback data to identify weak fields and generate prompt improvement suggestions.
 * This closes the feedback loop: user corrections → identify patterns → suggest prompt fixes.
 */
export async function analyzeFeedbackForPromptImprovement(
  days: number = 30,
): Promise<FeedbackAnalysisReport> {
  const stats = await getExtractionAccuracy(undefined, undefined, days);

  const totalItems = stats.reduce((sum, s) => sum + s.totalSuggestions, 0);
  const totalAccepted = stats.reduce((sum, s) => sum + s.acceptedCount, 0);
  const overallAcceptanceRate = totalItems > 0 ? totalAccepted / totalItems : 1;

  // Identify weak fields: rejection rate > 20% or edit rate > 15%, with min 5 samples
  const weakFields: WeakFieldReport[] = stats
    .filter((s) => s.totalSuggestions >= 5)
    .filter((s) => {
      const rejectionRate = s.rejectedCount / s.totalSuggestions;
      const editRate = s.editedCount / s.totalSuggestions;
      return rejectionRate > 0.20 || editRate > 0.15;
    })
    .map((s) => {
      const rejectionRate = s.rejectedCount / s.totalSuggestions;
      const editRate = s.editedCount / s.totalSuggestions;

      let suggestion = '';
      if (rejectionRate > 0.40) {
        suggestion = `CRITICAL: ${s.fieldKey} for ${s.credentialType} has ${(rejectionRate * 100).toFixed(0)}% rejection rate. Consider adding specific few-shot examples or tightening extraction rules.`;
      } else if (editRate > 0.30) {
        suggestion = `${s.fieldKey} for ${s.credentialType} is frequently edited (${(editRate * 100).toFixed(0)}%). Review common corrections to update extraction guidance.`;
      } else {
        suggestion = `${s.fieldKey} for ${s.credentialType} needs attention — ${(rejectionRate * 100).toFixed(0)}% rejected, ${(editRate * 100).toFixed(0)}% edited.`;
      }

      return {
        credentialType: s.credentialType,
        fieldKey: s.fieldKey,
        rejectionRate,
        editRate,
        totalFeedback: s.totalSuggestions,
        commonCorrections: [], // Populated by getCommonCorrections if available
        suggestion,
      };
    })
    .sort((a, b) => b.rejectionRate - a.rejectionRate);

  // Generate high-level suggestions
  const suggestions: string[] = [];
  if (overallAcceptanceRate < 0.70) {
    suggestions.push(`Overall acceptance rate is ${(overallAcceptanceRate * 100).toFixed(0)}% — below 70% threshold. Prompt needs significant revision.`);
  }

  const weakByType = new Map<string, number>();
  for (const wf of weakFields) {
    weakByType.set(wf.credentialType, (weakByType.get(wf.credentialType) ?? 0) + 1);
  }
  for (const [type, count] of weakByType) {
    if (count >= 3) {
      suggestions.push(`${type} has ${count} weak fields — consider adding more ${type}-specific few-shot examples.`);
    }
  }

  // Fetch common corrections for top weak fields
  for (const wf of weakFields.slice(0, 5)) {
    try {
      const corrections = await getCommonCorrections(wf.credentialType, wf.fieldKey, days);
      wf.commonCorrections = corrections;
    } catch {
      // Non-critical — continue without corrections
    }
  }

  return {
    analyzedAt: new Date().toISOString(),
    totalFeedbackItems: totalItems,
    weakFields,
    overallAcceptanceRate,
    promptImprovementSuggestions: suggestions,
  };
}

/**
 * Get common correction patterns for a specific field.
 * Identifies what users are changing original→corrected values to.
 */
async function getCommonCorrections(
  credentialType: string,
  fieldKey: string,
  days: number,
): Promise<Array<{ original: string; corrected: string; count: number }>> {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('extraction_feedback')
      .select('original_value, corrected_value')
      .eq('credential_type', credentialType)
      .eq('field_key', fieldKey)
      .eq('action', 'edited')
      .gte('created_at', cutoff)
      .not('corrected_value', 'is', null)
      .limit(100);

    if (error || !data) return [];

    // Count frequency of original→corrected pairs
    const counts = new Map<string, number>();
    for (const row of data as Array<{ original_value: string | null; corrected_value: string | null }>) {
      const key = `${row.original_value ?? '(empty)'}→${row.corrected_value ?? '(empty)'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([key, count]) => {
        const [original, corrected] = key.split('→');
        return { original, corrected, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  } catch {
    return [];
  }
}
