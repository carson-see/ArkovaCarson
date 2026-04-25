/**
 * Anchor Queue Resolution API (ARK-101 — SCRUM-1011)
 *
 * GET  /api/queue/pending       → list PENDING_RESOLUTION anchors for caller's org
 * POST /api/queue/resolve       → admin picks terminal version; siblings → REVOKED
 *
 * The heavy lifting lives in the DB RPCs `list_pending_resolution_anchors`
 * and `resolve_anchor_queue` (migration 0228). The endpoints here are thin
 * wrappers: authenticate via Supabase JWT, forward to the RPC under the
 * user's role, shape the response, map RPC exceptions to HTTP codes.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';
import { processBatchAnchors } from '../jobs/batch-anchor.js';
import { mapRpcErrorToStatus } from './rpc-error-status.js';

export { mapRpcErrorToStatus } from './rpc-error-status.js';

export interface PendingResolutionAnchor {
  public_id: string;
  external_file_id: string | null;
  filename: string | null;
  fingerprint: string;
  created_at: string;
  sibling_count: number;
}

// ARK-112 (SCRUM-1121): the queue API never accepts or returns the internal
// anchors.id UUID. public_id matches /^ARK-[A-Z0-9]+$/ (see migration 0036)
// so a strict regex rejects raw UUIDs at the boundary as defense-in-depth.
const PUBLIC_ID_RE = /^ARK-[A-Z0-9]+$/;

export const ResolveQueueInput = z.object({
  external_file_id: z.string().trim().min(1).max(255),
  selected_public_id: z.string().trim().min(1).max(64).regex(PUBLIC_ID_RE),
  reason: z.string().trim().max(2000).optional(),
});

function rpcErrorCodeForStatus(status: number): 'forbidden' | 'not_found' | 'conflict' | 'internal' {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'internal';
}

/**
 * GET /api/queue/pending
 * Returns anchors currently in PENDING_RESOLUTION for the caller's org,
 * with a `sibling_count` per row so the UI can badge collisions.
 *
 * Caller is authenticated upstream via `requireAuth` middleware — userId
 * is available on req but isn't forwarded here (the RPC reads `auth.uid()`).
 */
export async function handleListPendingResolution(
  req: Request,
  res: Response,
): Promise<void> {
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? '100', 10) || 100, 1),
    500,
  );

  try {
    const { data, error } = await callRpc<PendingResolutionAnchor[]>(
      db,
      'list_pending_resolution_anchors',
      { p_limit: limit },
    );

    if (error) {
      logger.error({ error }, 'list_pending_resolution_anchors RPC failed');
      res.status(500).json({ error: { code: 'rpc_failed', message: 'Failed to list pending resolutions' } });
      return;
    }

    const rows = Array.isArray(data) ? (data as PendingResolutionAnchor[]) : [];
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
    const { data, error } = await callRpc<string>(db, 'resolve_anchor_queue', {
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
      ? await getSelectedAnchorOrgIdByPublicId(parsed.data.selected_public_id)
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
    return null;
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
  const profile = await getCallerProfile(userId);
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

  try {
    const result = await processBatchAnchors({
      orgId,
      force: true,
      failIfRunning: true,
      workerId: `org-run-${orgId}-${userId}`,
    });

    if (result.error) {
      res.status(500).json({
        error: { code: 'run_failed', message: result.error },
      });
      return;
    }

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
    logger.error({ error: err, orgId, userId }, 'manual org queue run failed');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

async function getSelectedAnchorOrgIdByPublicId(publicId: string): Promise<string | null> {
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
