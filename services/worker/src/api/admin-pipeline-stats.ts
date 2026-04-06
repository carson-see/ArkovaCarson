/**
 * Pipeline Stats API — Arkova Internal Only
 *
 * GET /api/admin/pipeline-stats
 *
 * Returns public_records ingestion, anchoring, and embedding counts.
 * Uses service_role to bypass RLS on public_records tables.
 * Gated behind platform admin email whitelist.
 *
 * @see SCRUM-457
 */

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

export interface PipelineStatsResponse {
  totalRecords: number;
  anchoredRecords: number;
  pendingRecords: number;
  embeddedRecords: number;
  bySource: Record<string, number>;
}

export async function handlePipelineStats(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  try {
    const results = await Promise.allSettled([
      db.from('public_records').select('*', { count: 'exact', head: true }),
      db.from('public_records').select('*', { count: 'exact', head: true }).not('anchor_id', 'is', null),
      db.from('public_records').select('*', { count: 'exact', head: true }).is('anchor_id', null),
      db.from('public_record_embeddings').select('*', { count: 'exact', head: true }),
      db.rpc('count_public_records_by_source'),
    ]);

    const val = <T>(i: number): T | null => {
      const r = results[i];
      return r.status === 'fulfilled' ? (r.value as T) : null;
    };

    const totalRecords = val<{ count: number }>(0)?.count ?? 0;
    const anchoredRecords = val<{ count: number }>(1)?.count ?? 0;
    const pendingRecords = val<{ count: number }>(2)?.count ?? 0;
    const embeddedRecords = val<{ count: number }>(3)?.count ?? 0;

    const bySource: Record<string, number> = {};
    const sourceResult = val<{ data: Array<{ source: string; count: number }> }>(4);
    if (sourceResult?.data && Array.isArray(sourceResult.data)) {
      for (const row of sourceResult.data) {
        bySource[row.source] = row.count;
      }
    }

    res.json({
      totalRecords,
      anchoredRecords,
      pendingRecords,
      embeddedRecords,
      bySource,
    } satisfies PipelineStatsResponse);
  } catch (error) {
    logger.error({ error }, 'Pipeline stats request failed');
    res.status(500).json({ error: 'Failed to fetch pipeline stats' });
  }
}
