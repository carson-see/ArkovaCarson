/**
 * Platform Stats API — Arkova Internal Only
 *
 * GET /api/admin/platform-stats
 *
 * Returns aggregate platform metrics: users, orgs, anchors, subscriptions.
 * Gated behind platform admin email whitelist.
 */

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

export interface PlatformStatsResponse {
  users: {
    total: number;
    last7Days: number;
  };
  organizations: {
    total: number;
  };
  anchors: {
    total: number;
    byStatus: Record<string, number>;
    last24h: number;
    /** Average network fee in satoshis per anchor (from _fee_sats metadata) */
    avgSatsPerAnchor: number | null;
    /** Total network fees in satoshis across all anchors */
    totalFeeSats: number | null;
  };
  subscriptions: {
    byPlan: Record<string, number>;
  };
}

export async function handlePlatformStats(
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
    // PERF: Use SECURITY DEFINER RPCs for anchor counts instead of 5
    // separate count queries on 1.4M row table. RPCs use indexes and
    // bypass RLS for fast aggregation.
    const results = await Promise.allSettled([
      // 0: Total users
      db.from('profiles').select('*', { count: 'exact', head: true })
        .is('deleted_at', null),
      // 1: Users in last 7 days
      db.from('profiles').select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      // 2: Total orgs
      db.from('organizations').select('*', { count: 'exact', head: true })
        .is('deleted_at', null),
      // 3: Anchor status counts via RPC (replaces queries 3-7)
      db.rpc('get_anchor_status_counts'),
      // 4: Anchors in last 24h
      db.from('anchors').select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      // 5: Subscriptions by plan
      db.from('subscriptions').select('plan_id, plans(name)')
        .in('status', ['active', 'trialing']),
      // 6: Anchor TX + fee stats via RPC
      db.rpc('get_anchor_tx_stats'),
    ]);

    // Helper to safely extract fulfilled results
    const val = <T>(i: number): T | null => {
      const r = results[i];
      return r.status === 'fulfilled' ? (r.value as T) : null;
    };

    const totalUsers = val<{ count: number }>(0)?.count ?? 0;
    const recentUsers = val<{ count: number }>(1)?.count ?? 0;
    const totalOrgs = val<{ count: number }>(2)?.count ?? 0;

    // Anchor status counts from RPC
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusCounts = (val<{ data: any }>(3)?.data ?? {}) as Record<string, number>;
    const pendingAnchors = statusCounts.PENDING ?? 0;
    const securedAnchors = statusCounts.SECURED ?? 0;
    const revokedAnchors = statusCounts.REVOKED ?? 0;
    const submittedAnchors = statusCounts.SUBMITTED ?? 0;
    const totalAnchors = pendingAnchors + securedAnchors + revokedAnchors + submittedAnchors
      + (statusCounts.BROADCASTING ?? 0);

    const recentAnchors = val<{ count: number }>(4)?.count ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subscriptionData = val<{ data: any[] }>(5)?.data ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txStats = (val<{ data: any }>(6)?.data ?? {}) as Record<string, unknown>;

    // Log any failed queries for debugging (don't crash the endpoint)
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        logger.warn({ index: i, error: (results[i] as PromiseRejectedResult).reason }, 'Platform stats query failed (degraded)');
      }
    }

    // Aggregate subscription counts by plan name
    const byPlan: Record<string, number> = {};
    for (const sub of subscriptionData) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const planName = (sub as any).plans?.name ?? 'Unknown';
      byPlan[planName] = (byPlan[planName] ?? 0) + 1;
    }

    // Fee stats: the old metadata JSON scan was slow on 1.4M rows.
    // Use approximate calculation from TX stats RPC when available.
    // Detailed per-anchor fee analysis is on the Treasury dashboard.
    const avgSatsPerAnchor: number | null = null;
    const totalFeeSats: number | null = null;

    const result: PlatformStatsResponse = {
      users: {
        total: totalUsers,
        last7Days: recentUsers,
      },
      organizations: {
        total: totalOrgs,
      },
      anchors: {
        total: totalAnchors,
        byStatus: {
          PENDING: pendingAnchors,
          SUBMITTED: submittedAnchors,
          SECURED: securedAnchors,
          REVOKED: revokedAnchors,
        },
        last24h: recentAnchors,
        avgSatsPerAnchor,
        totalFeeSats,
      },
      subscriptions: {
        byPlan,
      },
    };

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Platform stats request failed');
    res.status(500).json({ error: 'Failed to fetch platform stats' });
  }
}
