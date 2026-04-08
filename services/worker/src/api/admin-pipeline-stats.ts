/**
 * Pipeline Stats API — Arkova Internal Only
 *
 * GET /api/admin/pipeline-stats
 *
 * Returns public_records ingestion, anchoring, and embedding counts.
 * Uses service_role to bypass RLS on public_records tables.
 * Gated behind platform admin DB flag (is_platform_admin in profiles).
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
    // Use get_pipeline_stats() RPC which uses reltuples estimates + partial indexes
    // for fast aggregation on the 1.4M+ row public_records table (migration 0175).
    // Falls back to direct count queries only if the RPC is unavailable.
    let totalRecords = 0;
    let anchoredRecords = 0;
    let pendingRecords = 0;
    let embeddedRecords = 0;
    const bySource: Record<string, number> = {};

    const [pipelineResult, sourceResult] = await Promise.allSettled([
      db.rpc('get_pipeline_stats'),
      db.rpc('count_public_records_by_source'),
    ]);

    // Extract pipeline stats from RPC
    if (pipelineResult.status === 'fulfilled') {
      const rpcResp = pipelineResult.value as { data: Record<string, unknown> | null; error: unknown };
      if (rpcResp.data && !rpcResp.error) {
        totalRecords = Number(rpcResp.data.total_records ?? 0);
        anchoredRecords = Number(rpcResp.data.anchored_records ?? 0);
        pendingRecords = Number(rpcResp.data.pending_records ?? 0);
        embeddedRecords = Number(rpcResp.data.embedded_records ?? 0);
      } else {
        logger.warn({ error: rpcResp.error }, 'get_pipeline_stats RPC returned error, falling back to count queries');
      }
    } else {
      logger.warn({ error: (pipelineResult as PromiseRejectedResult).reason }, 'get_pipeline_stats RPC failed');
    }

    // Fallback: direct count queries (may be slow on large tables)
    if (totalRecords === 0 && pipelineResult.status === 'rejected') {
      const countResults = await Promise.allSettled([
        db.from('public_records').select('*', { count: 'exact', head: true }),
        db.from('public_records').select('*', { count: 'exact', head: true }).not('anchor_id', 'is', null),
        db.from('public_records').select('*', { count: 'exact', head: true }).is('anchor_id', null),
        db.from('public_record_embeddings').select('*', { count: 'exact', head: true }),
      ]);
      const cval = <T>(i: number): T | null => {
        const r = countResults[i];
        return r.status === 'fulfilled' ? (r.value as T) : null;
      };
      totalRecords = cval<{ count: number }>(0)?.count ?? 0;
      anchoredRecords = cval<{ count: number }>(1)?.count ?? 0;
      pendingRecords = cval<{ count: number }>(2)?.count ?? 0;
      embeddedRecords = cval<{ count: number }>(3)?.count ?? 0;
    }

    // Extract source breakdown
    if (sourceResult.status === 'fulfilled') {
      const srcResp = sourceResult.value as { data: Array<{ source: string; count: number }> | null };
      if (srcResp?.data && Array.isArray(srcResp.data)) {
        for (const row of srcResp.data) {
          bySource[row.source] = Number(row.count);
        }
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
