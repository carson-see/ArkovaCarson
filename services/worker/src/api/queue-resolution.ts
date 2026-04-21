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

export interface PendingResolutionAnchor {
  id: string;
  external_file_id: string | null;
  filename: string | null;
  fingerprint: string;
  created_at: string;
  sibling_count: number;
}

export const ResolveQueueInput = z.object({
  external_file_id: z.string().trim().min(1).max(255),
  selected_anchor_id: z.string().uuid(),
  reason: z.string().trim().max(2000).optional(),
});

export function mapRpcErrorToStatus(message: string): number {
  const lowered = message.toLowerCase();
  if (lowered.includes('not found')) return 404;
  if (
    lowered.includes('insufficient_privilege') ||
    lowered.includes('different organization') ||
    lowered.includes('only organization administrators')
  ) {
    return 403;
  }
  if (
    lowered.includes('not awaiting resolution') ||
    lowered.includes('check_violation') ||
    lowered.includes('already been superseded') ||
    lowered.includes('is already') ||
    lowered.includes('legal hold')
  ) {
    return 409;
  }
  return 500;
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
      p_selected_anchor_id: parsed.data.selected_anchor_id,
      p_reason: parsed.data.reason ?? null,
    });

    if (error) {
      const status = mapRpcErrorToStatus(error.message ?? '');
      logger.warn({ error }, 'resolve_anchor_queue RPC returned error');
      res.status(status).json({
        error: {
          code:
            status === 403
              ? 'forbidden'
              : status === 404
                ? 'not_found'
                : status === 409
                  ? 'conflict'
                  : 'internal',
          message: error.message ?? 'Resolve failed',
        },
      });
      return;
    }

    res.json({ resolution_id: data });
  } catch (err) {
    logger.error({ error: err }, 'handleResolveQueue unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}
