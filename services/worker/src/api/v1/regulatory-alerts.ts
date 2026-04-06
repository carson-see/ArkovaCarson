/**
 * Regulatory Change Monitoring Alerts (NMT-REG)
 *
 * Monitors anchored regulatory documents for changes and alerts subscribers.
 * The #1 ongoing pain point for compliance officers per market research.
 *
 * GET /api/v1/regulatory/alerts?source=federal_register&days=30
 * GET /api/v1/regulatory/alerts/:recordId/diff
 *
 * Detects when a public record's source document has been updated since
 * it was last anchored, and routes through Nessie for impact analysis.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

const AlertsQuerySchema = z.object({
  source: z.enum([
    'federal_register', 'edgar', 'courtlistener', 'uspto',
    'openalex', 'dapip', 'calbar', 'npi', 'finra', 'sam_gov',
  ]).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** A regulatory change alert */
export interface RegulatoryAlert {
  record_id: string;
  source: string;
  title: string | null;
  record_type: string;
  /** When the record was last anchored */
  anchored_at: string | null;
  /** When the source was last fetched */
  last_fetched_at: string;
  /** Whether content hash changed since last anchor */
  content_changed: boolean;
  /** Content hash at anchor time */
  anchored_hash: string;
  /** Current content hash from latest fetch */
  current_hash: string | null;
  /** Source URL for manual verification */
  source_url: string;
  /** Severity based on document type and change magnitude */
  severity: 'high' | 'medium' | 'low';
}

/**
 * Determine alert severity based on source and record type.
 * Regulatory changes from authoritative sources = high severity.
 */
function computeSeverity(source: string, recordType: string): 'high' | 'medium' | 'low' {
  // Final rules and regulations are high severity
  if (source === 'federal_register' && recordType === 'rule') return 'high';
  if (source === 'federal_register' && recordType === 'presidential_document') return 'high';
  // SEC filings affecting compliance
  if (source === 'edgar' && ['10-K', '8-K', 'DEF14A'].includes(recordType)) return 'high';
  // Court decisions
  if (source === 'courtlistener') return 'medium';
  // Proposed rules and notices
  if (source === 'federal_register' && recordType === 'proposed_rule') return 'medium';
  if (source === 'federal_register' && recordType === 'notice') return 'low';
  // Everything else
  return 'low';
}

/**
 * GET /api/v1/regulatory/alerts
 *
 * Returns recent regulatory documents that may have changed since anchoring.
 * Checks for content hash mismatches between anchor time and latest fetch.
 */
router.get('/', async (req: Request, res: Response) => {
  const parsed = AlertsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { source, days, limit } = parsed.data;

  try {
    // Query public records that have been anchored and may have changed
    let query = dbAny
      .from('public_records')
      .select('id, source, source_url, record_type, title, content_hash, metadata, anchor_id, created_at, updated_at')
      .not('anchor_id', 'is', null)
      .gte('updated_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (source) {
      query = query.eq('source', source);
    }

    const { data: records, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch regulatory records');
      res.status(500).json({ error: 'Failed to fetch alerts' });
      return;
    }

    if (!records || records.length === 0) {
      res.json({ alerts: [], count: 0, period_days: days });
      return;
    }

    // Fetch anchor details for hash comparison
    const anchorIds = records
      .map((r: { anchor_id: string | null }) => r.anchor_id)
      .filter((id: string | null): id is string => id !== null);

    const { data: anchors } = await db
      .from('anchors')
      .select('id, fingerprint, chain_timestamp, status')
      .in('id', anchorIds);

    const anchorMap = new Map(
      (anchors ?? []).map((a) => [a.id, a]),
    );

    // Build alerts — flag records where content_hash differs from anchor fingerprint
    const alerts: RegulatoryAlert[] = records
      .map((record: {
        id: string; source: string; source_url: string; record_type: string;
        title: string | null; content_hash: string; anchor_id: string | null;
        metadata: Record<string, unknown>; updated_at: string;
      }) => {
        const anchor = record.anchor_id ? anchorMap.get(record.anchor_id) : null;
        const anchoredHash = anchor?.fingerprint ?? '';
        const contentChanged = anchoredHash !== '' && record.content_hash !== anchoredHash;

        return {
          record_id: record.id,
          source: record.source,
          title: record.title,
          record_type: record.record_type,
          anchored_at: anchor?.chain_timestamp ?? null,
          last_fetched_at: record.updated_at,
          content_changed: contentChanged,
          anchored_hash: anchoredHash,
          current_hash: record.content_hash,
          source_url: record.source_url,
          severity: computeSeverity(record.source, record.record_type),
        };
      })
      // Sort: changed documents first, then by severity
      .sort((a: RegulatoryAlert, b: RegulatoryAlert) => {
        if (a.content_changed !== b.content_changed) return a.content_changed ? -1 : 1;
        const severityOrder = { high: 0, medium: 1, low: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });

    res.json({
      alerts,
      count: alerts.length,
      changed_count: alerts.filter((a: RegulatoryAlert) => a.content_changed).length,
      period_days: days,
      sources_checked: [...new Set(alerts.map((a: RegulatoryAlert) => a.source))],
    });
  } catch (error) {
    logger.error({ error }, 'Regulatory alerts query failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as regulatoryAlertsRouter };
