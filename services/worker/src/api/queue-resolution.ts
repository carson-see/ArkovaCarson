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

/** Safely read a string field from an anchor's `metadata` JSON blob. */
function metadataString(metadata: unknown, key: string): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const v = (metadata as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * GET /api/queue/pending
 * Returns anchors currently in PENDING_RESOLUTION for the caller's org,
 * with a `sibling_count` per row so the UI can badge collisions.
 *
 * SCRUM-2213: the previous implementation called the RPC
 * `list_pending_resolution_anchors_v2`, which resolves the caller via
 * `auth.uid()`. But the worker invokes RPCs through the **service-role** client,
 * where `auth.uid()` is NULL → the RPC raised "Profile not found" → this endpoint
 * 500'd on every request and the Review Queue page hung. We now resolve the
 * caller's org explicitly from the authenticated `callerUserId` (passed by the
 * route, which already validated the JWT) and query org-scoped directly — no
 * `auth.uid()` dependency, and bounded/indexed (no full-table scan).
 */
export async function handleListPendingResolution(
  req: Request,
  res: Response,
  callerUserId?: string,
): Promise<void> {
  const limit = Math.min(
    Math.max(parseInt((req.query.limit as string) ?? '100', 10) || 100, 1),
    500,
  );

  if (!callerUserId) {
    res.status(401).json({ error: { code: 'authentication_required', message: 'Authentication required' } });
    return;
  }

  try {
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', callerUserId)
      .maybeSingle();

    if (profileError) {
      logger.error({ error: profileError, userId: callerUserId }, 'queue/pending: profile lookup failed');
      res.status(500).json({ error: { code: 'internal', message: 'Failed to list pending resolutions' } });
      return;
    }

    // No profile or no org → empty queue (renders an empty state, never an error).
    if (!profile?.org_id) {
      res.json({ items: [], count: 0 });
      return;
    }

    // Org-scoped PENDING_RESOLUTION fetch. Uses idx_anchors_org_status_created
    // (org_id, status, created_at DESC) WHERE deleted_at IS NULL — bounded + fast.
    // Fetch up to the 500 cap so sibling_count reflects the full pending set
    // before the display `limit` is applied (matching the prior RPC's window).
    const { data: rows, error: rowsError } = await db
      .from('anchors')
      .select('public_id, metadata, filename, fingerprint, created_at')
      .eq('org_id', profile.org_id)
      .eq('status', 'PENDING_RESOLUTION')
      .is('deleted_at', null)
      .not('public_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);

    if (rowsError) {
      logger.error({ error: rowsError, userId: callerUserId }, 'queue/pending: anchors query failed');
      res.status(500).json({ error: { code: 'internal', message: 'Failed to list pending resolutions' } });
      return;
    }

    const pending = rows ?? [];

    // sibling_count = number of OTHER pending anchors sharing the same
    // external_file_id (collision badge), computed over the full pending set.
    const countByFileId = new Map<string, number>();
    for (const r of pending) {
      const fid = metadataString(r.metadata, 'external_file_id');
      if (fid) countByFileId.set(fid, (countByFileId.get(fid) ?? 0) + 1);
    }

    const items: PendingResolutionAnchor[] = pending.slice(0, limit).map((r) => {
      const externalFileId = metadataString(r.metadata, 'external_file_id');
      return {
        public_id: r.public_id as string,
        external_file_id: externalFileId,
        filename: r.filename ?? null,
        fingerprint: r.fingerprint,
        created_at: r.created_at,
        sibling_count: externalFileId ? Math.max((countByFileId.get(externalFileId) ?? 1) - 1, 0) : 0,
      };
    });

    res.json({ items, count: items.length });
  } catch (err) {
    logger.error({ error: err, userId: callerUserId }, 'handleListPendingResolution unexpected error');
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
