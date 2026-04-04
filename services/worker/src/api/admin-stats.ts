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
    // Run all queries in parallel. Use allSettled so one failing query
    // (e.g. subscriptions FK join, large metadata scan) does not crash
    // the entire endpoint. SCRUM-352 fix.
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
      // 3: Total anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .is('deleted_at', null),
      // 4: Pending anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'PENDING').is('deleted_at', null),
      // 5: Secured anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'SECURED').is('deleted_at', null),
      // 6: Revoked anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'REVOKED').is('deleted_at', null),
      // 7: Submitted anchors
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'SUBMITTED').is('deleted_at', null),
      // 8: Anchors in last 24h
      db.from('anchors').select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      // 9: Subscriptions by plan
      db.from('subscriptions').select('plan_id, plans(name)')
        .in('status', ['active', 'trialing']),
      // 10: Anchor fee data — cap at 1000 recent rows to avoid timeout
      db.from('anchors').select('metadata')
        .not('metadata->_fee_sats', 'is', null)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1000),
    ]);

    // Helper to safely extract fulfilled results
    const val = <T>(i: number): T | null => {
      const r = results[i];
      return r.status === 'fulfilled' ? (r.value as T) : null;
    };

    const totalUsers = val<{ count: number }>(0)?.count ?? 0;
    const recentUsers = val<{ count: number }>(1)?.count ?? 0;
    const totalOrgs = val<{ count: number }>(2)?.count ?? 0;
    const totalAnchors = val<{ count: number }>(3)?.count ?? 0;
    const pendingAnchors = val<{ count: number }>(4)?.count ?? 0;
    const securedAnchors = val<{ count: number }>(5)?.count ?? 0;
    const revokedAnchors = val<{ count: number }>(6)?.count ?? 0;
    const submittedAnchors = val<{ count: number }>(7)?.count ?? 0;
    const recentAnchors = val<{ count: number }>(8)?.count ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subscriptionData = val<{ data: any[] }>(9)?.data ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feeData = val<{ data: any[] }>(10)?.data ?? [];

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

    // Calculate average sats per anchor from metadata._fee_sats
    let avgSatsPerAnchor: number | null = null;
    let totalFeeSats: number | null = null;
    if (feeData && feeData.length > 0) {
      let feeSum = 0;
      let feeCount = 0;
      for (const anchor of feeData) {
        const meta = anchor.metadata as Record<string, unknown> | null;
        const feeSats = meta?._fee_sats;
        if (typeof feeSats === 'number' && feeSats > 0) {
          // For batch anchors, divide batch fee by batch size to get per-anchor cost
          const batchId = meta?.batch_id as string | undefined;
          if (batchId) {
            // Count anchors in same batch to divide fee
            const batchAnchors = feeData.filter((a) => {
              const m = a.metadata as Record<string, unknown> | null;
              return m?.batch_id === batchId;
            });
            feeSum += feeSats / Math.max(batchAnchors.length, 1);
          } else {
            feeSum += feeSats;
          }
          feeCount++;
        }
      }
      if (feeCount > 0) {
        avgSatsPerAnchor = Math.round(feeSum / feeCount);
        totalFeeSats = Math.round(feeSum);
      }
    }

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
