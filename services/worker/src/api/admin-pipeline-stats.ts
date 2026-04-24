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
  /** Records with a Bitcoin tx id (SUBMITTED or SECURED), not merely an internal anchor row. */
  anchoredRecords: number;
  /** Records still missing a Bitcoin tx (unlinked, PENDING, or BROADCASTING). */
  pendingRecords: number;
  embeddedRecords: number;
  anchorLinkedRecords: number;
  pendingRecordLinks: number;
  pendingAnchorRecords: number;
  broadcastingRecords: number;
  submittedRecords: number;
  securedRecords: number;
  cacheUpdatedAt: string | null;
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
    let anchorLinkedRecords = 0;
    let pendingRecordLinks = 0;
    let pendingAnchorRecords = 0;
    let broadcastingRecords = 0;
    let submittedRecords = 0;
    let securedRecords = 0;
    let cacheUpdatedAt: string | null = null;
    let usedPipelineRpc = false;
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
        anchorLinkedRecords = Number(rpcResp.data.anchor_linked_records ?? rpcResp.data.anchored_records ?? 0);
        pendingRecordLinks = Number(rpcResp.data.pending_record_links ?? 0);
        pendingAnchorRecords = Number(rpcResp.data.pending_anchor_records ?? 0);
        broadcastingRecords = Number(rpcResp.data.broadcasting_records ?? 0);
        submittedRecords = Number(rpcResp.data.submitted_records ?? 0);
        securedRecords = Number(rpcResp.data.secured_records ?? 0);
        anchoredRecords = Number(
          rpcResp.data.bitcoin_anchored_records ??
          rpcResp.data.anchored_records ??
          0,
        );
        pendingRecords = Number(
          rpcResp.data.pending_bitcoin_records ??
          rpcResp.data.pending_records ??
          0,
        );
        embeddedRecords = Number(rpcResp.data.embedded_records ?? 0);
        cacheUpdatedAt = typeof rpcResp.data.cache_updated_at === 'string'
          ? rpcResp.data.cache_updated_at
          : null;
        usedPipelineRpc = true;
      } else {
        logger.warn({ error: rpcResp.error }, 'get_pipeline_stats RPC returned error, falling back to count queries');
      }
    } else {
      logger.warn({ error: (pipelineResult as PromiseRejectedResult).reason }, 'get_pipeline_stats RPC failed');
    }

    // Fallback: direct count queries (may be slow on large tables)
    if (!usedPipelineRpc) {
      const dbAny = db as any;
      const countResults = await Promise.allSettled([
        db.from('public_records').select('*', { count: 'exact', head: true }),
        db.from('public_records').select('*', { count: 'exact', head: true }).not('anchor_id', 'is', null),
        db.from('public_records').select('*', { count: 'exact', head: true }).is('anchor_id', null),
        db.from('public_record_embeddings').select('*', { count: 'exact', head: true }),
        dbAny.from('anchors').select('*', { count: 'exact', head: true }).not('metadata->>pipeline_source', 'is', null).eq('status', 'PENDING').is('deleted_at', null),
        dbAny.from('anchors').select('*', { count: 'exact', head: true }).not('metadata->>pipeline_source', 'is', null).eq('status', 'BROADCASTING').is('deleted_at', null),
        dbAny.from('anchors').select('*', { count: 'exact', head: true }).not('metadata->>pipeline_source', 'is', null).eq('status', 'SUBMITTED').not('chain_tx_id', 'is', null).is('deleted_at', null),
        dbAny.from('anchors').select('*', { count: 'exact', head: true }).not('metadata->>pipeline_source', 'is', null).eq('status', 'SECURED').not('chain_tx_id', 'is', null).is('deleted_at', null),
      ]);
      const cval = <T>(i: number): T | null => {
        const r = countResults[i];
        return r.status === 'fulfilled' ? (r.value as T) : null;
      };
      totalRecords = cval<{ count: number }>(0)?.count ?? 0;
      anchorLinkedRecords = cval<{ count: number }>(1)?.count ?? 0;
      pendingRecordLinks = cval<{ count: number }>(2)?.count ?? 0;
      embeddedRecords = cval<{ count: number }>(3)?.count ?? 0;
      pendingAnchorRecords = cval<{ count: number }>(4)?.count ?? 0;
      broadcastingRecords = cval<{ count: number }>(5)?.count ?? 0;
      submittedRecords = cval<{ count: number }>(6)?.count ?? 0;
      securedRecords = cval<{ count: number }>(7)?.count ?? 0;
      anchoredRecords = submittedRecords + securedRecords;
      pendingRecords = pendingRecordLinks + pendingAnchorRecords + broadcastingRecords;
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
      anchorLinkedRecords,
      pendingRecordLinks,
      pendingAnchorRecords,
      broadcastingRecords,
      submittedRecords,
      securedRecords,
      cacheUpdatedAt,
      bySource,
    } satisfies PipelineStatsResponse);
  } catch (error) {
    logger.error({ error }, 'Pipeline stats request failed');
    res.status(500).json({ error: 'Failed to fetch pipeline stats' });
  }
}
