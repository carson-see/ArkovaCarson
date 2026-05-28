/**
 * Anchor Queue Resolution API (ARK-101 — SCRUM-1011)
 *
 * GET  /api/queue/pending       → list PENDING_RESOLUTION anchors for caller's org
 * POST /api/queue/resolve       → admin picks terminal version; siblings → REVOKED
 *
 * GET /api/queue/pending derives the caller org from their profile, then
 * queries anchors directly so the service-role worker does not depend on
 * auth.uid(). POST /api/queue/resolve still delegates terminal-version
 * resolution to the queue RPC and maps RPC exceptions to HTTP codes.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';
import { processBatchAnchors } from '../jobs/batch-anchor.js';
import { recordOrgQueueRunResult } from '../jobs/org-queue-scheduler.js';
import { mapRpcErrorToStatus } from './rpc-error-status.js';

export { mapRpcErrorToStatus } from './rpc-error-status.js';

/**
 * SCRUM-1121: row identifier round-tripped to clients is `public_id`, the
 * short opaque slug. Internal `anchors.id` UUID never leaves the server per
 * CLAUDE.md §6 ("Only `public_id` + derived fields").
 */
export interface PendingResolutionAnchor {
  public_id: string;
  external_file_id: string | null;
  filename: string | null;
  fingerprint: string;
  created_at: string;
  sibling_count: number;
}

// `.strict()` rejects unknown keys — important here because a caller still
// posting the legacy `selected_anchor_id` field would otherwise silently
// strip it and process the request without our new public_id parameter.
export const ResolveQueueInput = z
  .object({
    external_file_id: z.string().trim().min(1).max(255),
    selected_public_id: z.string().trim().min(1).max(50),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

function rpcErrorCodeForStatus(status: number): 'forbidden' | 'not_found' | 'conflict' | 'internal' {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'internal';
}

function metadataExternalFileId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const externalFileId = (metadata as Record<string, unknown>).external_file_id;
  return typeof externalFileId === 'string' ? externalFileId : null;
}

function parsePendingLimit(rawLimit: unknown): number {
  const parsed = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : Number.NaN;
  const requested = Number.isNaN(parsed) ? 100 : parsed;
  return Math.min(Math.max(requested, 1), 500);
}

/**
 * GET /api/queue/pending
 * Returns anchors currently in PENDING_RESOLUTION for the caller's org.
 *
 * Bug fix: the old implementation called `list_pending_resolution_anchors_v2`
 * RPC which uses `auth.uid()` internally. The worker's service_role client
 * has no JWT context → auth.uid() = NULL → "Profile not found" → 500.
 * Fix: look up caller profile via userId, then query anchors directly.
 */
export async function handleListPendingResolution(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const limit = parsePendingLimit(req.query.limit);

  try {
    let profile: CallerProfile | null;
    try {
      profile = await getCallerProfile(userId);
    } catch (err) {
      logger.error({ error: err }, 'profiles lookup failed for pending resolution');
      res.status(500).json({ error: { code: 'internal_error', message: 'Profile lookup failed' } });
      return;
    }

    if (!profile) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Profile not found' } });
      return;
    }

    const orgId = profile.org_id ?? null;
    if (!orgId) {
      res.json({ items: [], count: 0 });
      return;
    }

    const { data, error } = await db
      .from('anchors')
      .select('public_id, metadata, filename, fingerprint, created_at')
      .eq('org_id', orgId)
      .eq('status', 'PENDING_RESOLUTION')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error({ error }, 'anchors query for pending resolution failed');
      res.status(500).json({ error: { code: 'query_failed', message: 'Failed to list pending resolutions' } });
      return;
    }

    const pendingAnchors = Array.isArray(data) ? data : [];
    const siblingCounts = new Map<string, number>();
    const externalFileIds = pendingAnchors.map((r) => metadataExternalFileId(r.metadata));
    const uniqueExternalFileIds = [...new Set(externalFileIds.filter((id): id is string => id !== null))];
    if (uniqueExternalFileIds.length > 0) {
      const pageSize = 1000;
      let offset = 0;
      for (;;) {
        const { data: siblingData, error: siblingError } = await db
          .from('anchors')
          .select('metadata')
          .eq('org_id', orgId)
          .eq('status', 'PENDING_RESOLUTION')
          .is('deleted_at', null)
          .in('metadata->>external_file_id', uniqueExternalFileIds)
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (siblingError) {
          logger.error({ error: siblingError }, 'anchors sibling count query for pending resolution failed');
          res.status(500).json({ error: { code: 'query_failed', message: 'Failed to list pending resolutions' } });
          return;
        }

        const siblingRows = Array.isArray(siblingData) ? siblingData : [];
        for (const siblingRow of siblingRows) {
          const externalFileId = metadataExternalFileId(siblingRow.metadata);
          if (externalFileId !== null) {
            siblingCounts.set(externalFileId, (siblingCounts.get(externalFileId) ?? 0) + 1);
          }
        }

        if (siblingRows.length < pageSize) {
          break;
        }
        offset += pageSize;
      }
    }

    const rows = pendingAnchors.map((r, index) => ({
      public_id: r.public_id,
      external_file_id: externalFileIds[index] ?? null,
      filename: r.filename,
      fingerprint: r.fingerprint,
      created_at: r.created_at,
      sibling_count: externalFileIds[index] != null
        ? Math.max((siblingCounts.get(externalFileIds[index]) ?? 1) - 1, 0)
        : 0,
    }));
    res.json({ items: rows, count: rows.length });
  } catch (err) {
    logger.error({ error: err }, 'handleListPendingResolution unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

/**
 * POST /api/queue/resolve
 * Admin picks the terminal version among PENDING_RESOLUTION anchors sharing
 * an external_file_id. Resolution RPC enforces ORG_ADMIN role, row-locks the
 * collision set, flips selected → PENDING, siblings → REVOKED, and records
 * the audit event.
 */
export async function handleResolveQueue(
  req: Request,
  res: Response,
  actorUserId?: string,
): Promise<void> {
  const parsed = ResolveQueueInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Invalid body',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  try {
    const { data, error } = await callRpc<string>(db, 'resolve_anchor_queue_by_public_id', {
      p_external_file_id: parsed.data.external_file_id,
      p_selected_public_id: parsed.data.selected_public_id,
      p_reason: parsed.data.reason ?? null,
    });

    if (error) {
      const status = mapRpcErrorToStatus(error.message ?? '');
      logger.warn({ error }, 'resolve_anchor_queue RPC returned error');
      // 500-class errors never leak raw RPC messages — the underlying error
      // may include internal role names, column names, or trigger details
      // that are useful in logs but not in the HTTP response.
      const isInternal = status >= 500;
      res.status(status).json({
        error: {
          code: rpcErrorCodeForStatus(status),
          message: isInternal ? 'Internal server error' : error.message ?? 'Resolve failed',
        },
      });
      return;
    }

    res.json({ resolution_id: data });
    const notificationOrgId = actorUserId
      ? await getSelectedAnchorOrgId(parsed.data.selected_public_id)
      : null;
    if (notificationOrgId) {
      void emitOrgAdminNotifications({
        type: 'queue_run_completed',
        organizationId: notificationOrgId,
        payload: {
          resolutionId: data,
          externalFileId: parsed.data.external_file_id,
          selectedPublicId: parsed.data.selected_public_id,
          actorUserId,
        },
      });
    }
  } catch (err) {
    logger.error({ error: err }, 'handleResolveQueue unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

interface CallerProfile {
  org_id?: string | null;
  role?: string | null;
  is_platform_admin?: boolean | null;
}

async function getCallerProfile(userId: string): Promise<CallerProfile | null> {
  const { data, error } = await db
    .from('profiles')
    .select('org_id, role, is_platform_admin')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.warn({ error, userId }, 'profiles lookup failed for queue run');
    throw new Error('Profile lookup failed');
  }

  return (data as CallerProfile | null) ?? null;
}

async function isOrgAdmin(
  userId: string,
  orgId: string,
  profile: CallerProfile | null,
): Promise<boolean> {
  const { data: membership, error: membershipError } = await db
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (membershipError) {
    logger.warn({ error: membershipError, userId, orgId }, 'org admin lookup failed for queue run');
  }

  const memberRole = (membership as { role?: string } | null)?.role;
  return (
    memberRole === 'owner' ||
    memberRole === 'admin' ||
    profile?.role === 'ORG_ADMIN' ||
    profile?.is_platform_admin === true
  );
}

/**
 * POST /api/queue/run
 * Organization admins can force a batch run for their own org queue. The
 * underlying claim RPC still owns row locking and PENDING → BROADCASTING, so
 * this endpoint cannot bypass the worker safety rails or claim another org's
 * anchors.
 */
export async function handleRunOrgAnchorQueue(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  let profile: CallerProfile | null;
  try {
    profile = await getCallerProfile(userId);
  } catch (err) {
    logger.error({ error: err, userId }, 'profiles lookup failed for manual org queue run');
    res.status(500).json({ error: { code: 'internal_error', message: 'Profile lookup failed' } });
    return;
  }

  const orgId = profile?.org_id ?? null;
  if (!orgId) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'No organization on profile' },
    });
    return;
  }

  if (!(await isOrgAdmin(userId, orgId, profile))) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Only organization admins can run anchoring jobs' },
    });
    return;
  }

  const startedAt = new Date();
  try {
    const result = await processBatchAnchors({ force: true, orgId });
    const finishedAt = new Date();
    await recordOrgQueueRunResult({
      orgId,
      trigger: 'manual',
      status: 'succeeded',
      startedAt,
      finishedAt,
      processed: result.processed,
      batchId: result.batchId,
      merkleRoot: result.merkleRoot,
      txId: result.txId,
      triggeredBy: userId,
    });

    res.json({ ok: true, ...result });
    void emitOrgAdminNotifications({
      type: 'queue_run_completed',
      organizationId: orgId,
      payload: {
        triggeredBy: userId,
        trigger: 'manual',
        processed: result.processed,
        batchId: result.batchId,
        txId: result.txId,
        merkleRoot: result.merkleRoot,
      },
    });
  } catch (err) {
    const finishedAt = new Date();
    await recordOrgQueueRunResult({
      orgId,
      trigger: 'manual',
      status: 'failed',
      startedAt,
      finishedAt,
      processed: 0,
      batchId: null,
      merkleRoot: null,
      txId: null,
      triggeredBy: userId,
      error: err instanceof Error ? err.message : 'manual org queue run failed',
    });
    logger.error({ error: err, orgId, userId }, 'manual org queue run failed');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

async function getSelectedAnchorOrgId(publicId: string): Promise<string | null> {
  const { data, error } = await db
    .from('anchors')
    .select('org_id')
    .eq('public_id', publicId)
    .maybeSingle();

  if (error) {
    logger.warn({ error, publicId }, 'Failed to load selected anchor org for queue notification');
    return null;
  }

  return (data?.org_id as string | null) ?? null;
}
