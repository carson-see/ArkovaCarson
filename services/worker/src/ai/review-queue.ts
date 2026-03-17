/**
 * Review Queue Service (P8-S9)
 *
 * Manages the admin review queue for flagged credentials.
 * Items are auto-created when integrity scores fall below threshold,
 * and admins can approve, investigate, escalate, or dismiss.
 *
 * EU AI Act compliance: Human-in-the-loop for automated decisions.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

// =============================================================================
// TYPES
// =============================================================================

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'INVESTIGATING' | 'ESCALATED' | 'DISMISSED';
export type ReviewAction = 'APPROVE' | 'INVESTIGATE' | 'ESCALATE' | 'DISMISS';

export interface ReviewQueueItem {
  id: string;
  anchorId: string;
  orgId: string;
  integrityScoreId: string | null;
  status: ReviewStatus;
  priority: number;
  reason: string;
  flags: string[];
  assignedTo: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  reviewAction: ReviewAction | null;
  createdAt: string;
  updatedAt: string;
  // Joined fields from anchor
  anchorTitle?: string;
  anchorFingerprint?: string;
  anchorCredentialType?: string;
  integrityScore?: number;
  integrityLevel?: string;
}

export interface ReviewQueueFilters {
  orgId: string;
  status?: ReviewStatus;
  priority?: number;
  limit?: number;
  offset?: number;
}

export interface ReviewQueueStats {
  total: number;
  pending: number;
  investigating: number;
  escalated: number;
  approved: number;
  dismissed: number;
}

// =============================================================================
// SCHEMAS
// =============================================================================

export const ReviewActionSchema = z.object({
  action: z.enum(['APPROVE', 'INVESTIGATE', 'ESCALATE', 'DISMISS']),
  notes: z.string().max(2000).optional(),
});

// =============================================================================
// AUTO-CREATE REVIEW ITEM
// =============================================================================

/**
 * Auto-create a review queue item when an anchor is flagged.
 * Called by the integrity scoring pipeline when score < threshold.
 */
export async function createReviewItem(
  anchorId: string,
  orgId: string,
  integrityScoreId: string | null,
  reason: string,
  flags: string[],
  priority: number = 5,
): Promise<string | null> {
  try {
    // Check for existing pending review item for this anchor
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (db as any)
      .from('review_queue_items')
      .select('id')
      .eq('anchor_id', anchorId)
      .in('status', ['PENDING', 'INVESTIGATING'])
      .limit(1);

    if (existing && existing.length > 0) {
      logger.info({ anchorId }, 'Review item already exists, skipping');
      return existing[0].id;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('review_queue_items')
      .insert({
        anchor_id: anchorId,
        org_id: orgId,
        integrity_score_id: integrityScoreId,
        status: 'PENDING',
        priority: Math.min(10, Math.max(0, priority)),
        reason,
        flags,
      })
      .select('id')
      .single();

    if (error) {
      logger.error({ error, anchorId }, 'Failed to create review item');
      return null;
    }

    return data?.id ?? null;
  } catch (err) {
    logger.error({ error: err, anchorId }, 'Failed to create review item');
    return null;
  }
}

// =============================================================================
// LIST REVIEW ITEMS
// =============================================================================

/**
 * List review queue items for an org with optional filters.
 */
export async function listReviewItems(
  filters: ReviewQueueFilters,
): Promise<ReviewQueueItem[]> {
  try {
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from('review_queue_items')
      .select(`
        *,
        anchors!inner(label, fingerprint, credential_type),
        integrity_scores(overall_score, level)
      `)
      .eq('org_id', filters.orgId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to list review items');
      return [];
    }

    if (!data) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.map((row: any) => ({
      id: row.id,
      anchorId: row.anchor_id,
      orgId: row.org_id,
      integrityScoreId: row.integrity_score_id,
      status: row.status,
      priority: row.priority,
      reason: row.reason,
      flags: row.flags ?? [],
      assignedTo: row.assigned_to,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      reviewNotes: row.review_notes,
      reviewAction: row.review_action,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      anchorTitle: row.anchors?.label ?? 'Untitled',
      anchorFingerprint: row.anchors?.fingerprint,
      anchorCredentialType: row.anchors?.credential_type,
      integrityScore: row.integrity_scores?.overall_score != null
        ? Number(row.integrity_scores.overall_score) : undefined,
      integrityLevel: row.integrity_scores?.level,
    }));
  } catch (err) {
    logger.error({ error: err }, 'Failed to list review items');
    return [];
  }
}

// =============================================================================
// UPDATE REVIEW ITEM
// =============================================================================

/**
 * Apply a review action (approve, investigate, escalate, dismiss).
 */
export async function updateReviewItem(
  itemId: string,
  userId: string,
  orgId: string,
  action: ReviewAction,
  notes?: string,
): Promise<boolean> {
  try {
    const statusMap: Record<ReviewAction, ReviewStatus> = {
      APPROVE: 'APPROVED',
      INVESTIGATE: 'INVESTIGATING',
      ESCALATE: 'ESCALATED',
      DISMISS: 'DISMISSED',
    };

    // Org-scoped update: ensures item belongs to caller's org (prevents cross-tenant access)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('review_queue_items')
      .update({
        status: statusMap[action],
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
        review_action: action,
        review_notes: notes ?? null,
      })
      .eq('id', itemId)
      .eq('org_id', orgId);

    if (error) {
      logger.error({ error, itemId }, 'Failed to update review item');
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ error: err, itemId }, 'Failed to update review item');
    return false;
  }
}

// =============================================================================
// QUEUE STATS
// =============================================================================

/**
 * Get review queue statistics for an org.
 */
export async function getReviewQueueStats(orgId: string): Promise<ReviewQueueStats> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('review_queue_items')
      .select('status')
      .eq('org_id', orgId);

    if (error || !data) {
      return { total: 0, pending: 0, investigating: 0, escalated: 0, approved: 0, dismissed: 0 };
    }

    const stats: ReviewQueueStats = {
      total: data.length,
      pending: 0,
      investigating: 0,
      escalated: 0,
      approved: 0,
      dismissed: 0,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of data as any[]) {
      const status = row.status as string;
      if (status === 'PENDING') stats.pending++;
      else if (status === 'INVESTIGATING') stats.investigating++;
      else if (status === 'ESCALATED') stats.escalated++;
      else if (status === 'APPROVED') stats.approved++;
      else if (status === 'DISMISSED') stats.dismissed++;
    }

    return stats;
  } catch (err) {
    logger.error({ error: err }, 'Failed to get review queue stats');
    return { total: 0, pending: 0, investigating: 0, escalated: 0, approved: 0, dismissed: 0 };
  }
}
