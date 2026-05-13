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
  /** Records confirmed on-chain (SECURED), not merely submitted to mempool. */
  anchoredRecords: number | null;
  /** Records not yet confirmed (unlinked, PENDING, BROADCASTING, or SUBMITTED). */
  pendingRecords: number | null;
  embeddedRecords: number | null;
  anchorLinkedRecords: number | null;
  pendingRecordLinks: number | null;
  pendingAnchorRecords: number | null;
  broadcastingRecords: number | null;
  submittedRecords: number | null;
  securedRecords: number | null;
  cacheUpdatedAt: string | null;
  statusCountsAvailable: boolean;
  statusCountsWarning: string | null;
  bySource: Record<string, number>;
}

type NullableCount = number | null;

function toNonNegativeCount(value: unknown): NullableCount {
  let parsed = Number.NaN;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value);
  }
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function addCounts(...counts: NullableCount[]): NullableCount {
  let sum = 0;
  for (const count of counts) {
    if (count === null) return null;
    sum += count;
  }
  return sum;
}

function hasAnyUnavailableCount(...counts: NullableCount[]): boolean {
  return counts.includes(null);
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
    let anchoredRecords: NullableCount = 0;
    let pendingRecords: NullableCount = 0;
    let embeddedRecords: NullableCount = 0;
    let anchorLinkedRecords: NullableCount = 0;
    let pendingRecordLinks: NullableCount = 0;
    let pendingAnchorRecords: NullableCount = 0;
    let broadcastingRecords: NullableCount = 0;
    let submittedRecords: NullableCount = 0;
    let securedRecords: NullableCount = 0;
    let cacheUpdatedAt: string | null = null;
    let statusCountsAvailable = true;
    let statusCountsWarning: string | null = null;
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
        const cacheMiss = rpcResp.data.cache_miss === true;
        totalRecords = toNonNegativeCount(rpcResp.data.total_records) ?? 0;
        anchorLinkedRecords = toNonNegativeCount(rpcResp.data.anchor_linked_records ?? rpcResp.data.anchored_records);
        pendingRecordLinks = toNonNegativeCount(rpcResp.data.pending_record_links);
        pendingAnchorRecords = toNonNegativeCount(rpcResp.data.pending_anchor_records);
        broadcastingRecords = toNonNegativeCount(rpcResp.data.broadcasting_records);
        submittedRecords = toNonNegativeCount(rpcResp.data.submitted_records);
        securedRecords = toNonNegativeCount(rpcResp.data.secured_records);
        embeddedRecords = toNonNegativeCount(rpcResp.data.embedded_records);

        const pendingBase = toNonNegativeCount(
          rpcResp.data.pending_bitcoin_records ??
          rpcResp.data.pending_records,
        );
        const legacyAnchored = toNonNegativeCount(
          rpcResp.data.bitcoin_anchored_records ??
          rpcResp.data.anchored_records,
        );

        const lifecycleUnavailable = cacheMiss ||
          hasAnyUnavailableCount(
            pendingRecordLinks,
            pendingAnchorRecords,
            broadcastingRecords,
            submittedRecords,
            securedRecords,
          );

        statusCountsAvailable = !lifecycleUnavailable;
        if (cacheMiss) {
          statusCountsWarning = 'Pipeline lifecycle counts unavailable: cache miss returned approximate placeholders.';
          anchorLinkedRecords = null;
          pendingRecordLinks = null;
          pendingAnchorRecords = null;
          broadcastingRecords = null;
          submittedRecords = null;
          securedRecords = null;
        } else if (lifecycleUnavailable) {
          statusCountsWarning = 'Pipeline lifecycle counts unavailable: cache returned timeout sentinels or missing buckets.';
        }

        if (cacheMiss) {
          anchoredRecords = null;
          pendingRecords = null;
        } else {
          anchoredRecords = legacyAnchored;
          if (rpcResp.data.secured_records != null) {
            anchoredRecords = securedRecords;
          }

          let submittedCountForPending: NullableCount = 0;
          if (rpcResp.data.pending_bitcoin_records != null) {
            submittedCountForPending = submittedRecords;
          }
          pendingRecords = addCounts(pendingBase, submittedCountForPending);
        }
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

    // SCRUM-1259 (R1-5): the previous fallback fanned out 8 exact-count
    // queries against the bloated `anchors` + `public_records` tables when
    // the RPC failed. Each query was a 60s PostgREST timeout candidate; the
    // 8-of-them-in-parallel pattern was a known DOS-on-our-own-DB. When the
    // RPC is unavailable now, return 503 with a clear error so the frontend
    // shows an explicit "Pipeline stats temporarily unavailable" banner
    // instead of silent zeros. R1-2's refresh_cache_pipeline_stats rewrite
    // and the in-flight autovacuum should make RPC failure rare; if it
    // becomes common we'll add a last-known-good cache read here.
    if (!usedPipelineRpc) {
      logger.warn('admin-pipeline-stats: get_pipeline_stats RPC unavailable; returning 503');
      res.status(503).json({
        error: 'Pipeline stats temporarily unavailable',
        detail: 'Backing aggregation function failed; retry shortly.',
      });
      return;
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
      statusCountsAvailable,
      statusCountsWarning,
      bySource,
    } satisfies PipelineStatsResponse);
  } catch (error) {
    logger.error({ error }, 'Pipeline stats request failed');
    res.status(500).json({ error: 'Failed to fetch pipeline stats' });
  }
}
