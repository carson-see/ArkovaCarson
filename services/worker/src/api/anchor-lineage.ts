/**
 * Anchor Lineage + Supersede API (ARK-104 — SCRUM-1014)
 *
 * GET  /api/anchor/:public_id/lineage  → full version chain (root..head)
 * POST /api/anchor/:id/supersede       → atomic supersede with new fingerprint
 *
 * Backed by `get_anchor_lineage` + `supersede_anchor` RPCs (migration 0226
 * + 0232). Per CLAUDE.md §1.4, the GET handler exposes only `public_id` +
 * derived fields — never the internal UUID. The persistent-URI guarantee
 * still holds: any public_id in a lineage resolves via the verify page
 * through `get_current_anchor_public_id`.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { mapRpcErrorToStatus } from './rpc-error-status.js';

export const SupersedeInput = z.object({
  new_fingerprint: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i, 'fingerprint must be 64-char hex SHA-256'),
  reason: z.string().trim().max(2000).optional(),
});

/**
 * Public shape returned by /api/anchor/:public_id/lineage.
 *
 * Intentionally omits the internal `anchors.id` UUID and `parent_anchor_id`
 * (replaced with `parent_public_id`), plus `revocation_reason` which is
 * admin-authored free-text that may contain PII or internal notes.
 *
 * Migration 0232 enforces this shape at the SQL layer.
 */
export interface LineageItem {
  public_id: string;
  version_number: number;
  parent_public_id: string | null;
  status: string;
  fingerprint: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  created_at: string;
  revoked_at: string | null;
  is_current: boolean;
}

const UuidSchema = z.string().uuid();
// public_id is the external handle (short opaque string). Validated loosely —
// the RPC does the authoritative existence check + returns 'Anchor not found'.
const PublicIdSchema = z
  .string()
  .trim()
  .min(1, 'public_id is required')
  .max(128, 'public_id too long');

/**
 * GET /api/anchor/:public_id/lineage
 * Returns [root, ..., head] for the lineage that contains `:public_id`.
 * Accepts the caller-facing public_id — the internal UUID never crosses the
 * HTTP boundary. Unauth-readable (matches public verify behavior).
 */
export async function handleAnchorLineage(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = PublicIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'Invalid public_id' },
    });
    return;
  }

  try {
    const { data, error } = await callRpc<LineageItem[]>(db, 'get_anchor_lineage', {
      p_public_id: parsed.data,
    });

    if (error) {
      const status = mapRpcErrorToStatus(error.message ?? '');
      // 500-class errors never leak raw RPC messages.
      const isInternal = status >= 500;
      res.status(status).json({
        error: {
          code: status === 404 ? 'not_found' : isInternal ? 'internal' : 'rpc_failed',
          message: isInternal ? 'Internal server error' : error.message ?? 'Lineage lookup failed',
        },
      });
      return;
    }

    const items = Array.isArray(data) ? (data as LineageItem[]) : [];
    const head = items.find((i) => i.is_current) ?? items[items.length - 1] ?? null;
    res.json({
      items,
      count: items.length,
      head_public_id: head?.public_id ?? null,
    });
  } catch (err) {
    logger.error({ error: err }, 'handleAnchorLineage unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

/**
 * POST /api/anchor/:id/supersede
 * Org admin atomically revokes :id (→ SUPERSEDED) and creates a child anchor
 * with `new_fingerprint` (→ PENDING). RPC is idempotent on (parent, fingerprint).
 */
export async function handleSupersedeAnchor(
  req: Request,
  res: Response,
): Promise<void> {
  const idParsed = UuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'Invalid anchor id' },
    });
    return;
  }
  const bodyParsed = SupersedeInput.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Invalid body',
        details: bodyParsed.error.flatten(),
      },
    });
    return;
  }

  try {
    const { data, error } = await callRpc<string>(db, 'supersede_anchor', {
      old_anchor_id: idParsed.data,
      new_fingerprint: bodyParsed.data.new_fingerprint,
      reason: bodyParsed.data.reason ?? null,
    });

    if (error) {
      const status = mapRpcErrorToStatus(error.message ?? '');
      // Only 500-class leaks raw RPC messages. Everything else gets a client-
      // actionable code mapped from the status — never 'conflict' for non-409.
      const isInternal = status >= 500;
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
          message: isInternal ? 'Internal server error' : error.message ?? 'Supersede failed',
        },
      });
      return;
    }

    res.json({ new_anchor_id: data });
  } catch (err) {
    logger.error({ error: err }, 'handleSupersedeAnchor unexpected error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}
