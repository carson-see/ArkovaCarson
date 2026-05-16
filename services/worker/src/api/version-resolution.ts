/**
 * Version Resolution API (SCRUM-1971)
 *
 * GET  /api/v1/versions                    -> list pending version reviews for caller's org
 * POST /api/v1/versions/:versionId/resolve -> resolve a version conflict (approve/skip/flag)
 *
 * Operates on the `external_document_versions` table. Org admins review
 * detected document version changes and decide whether to anchor the new
 * fingerprint, skip it, or flag it for further investigation.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const VALID_STATUSES = ['pending_review', 'approved', 'skipped', 'flagged'] as const;
type VersionStatus = typeof VALID_STATUSES[number];

export const ResolveVersionInput = z
  .object({
    decision: z.enum(['approve', 'skip', 'flag']),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

// ─── Auth + role helpers ───────────────────────────────────────────────────────

function getUserId(req: Request): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).userId ?? null;
}

function getOrgId(req: Request): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).orgId ?? null;
}

function getOrgRole(req: Request): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).orgRole ?? null;
}

function isAdmin(role: string | null): boolean {
  return role === 'admin' || role === 'owner';
}

// ─── Handlers ────���─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/versions
 * Returns document versions pending review for the caller's organization.
 * Supports ?status= query filter (defaults to 'pending_review').
 * Ordered by detected_at DESC, limit 50.
 */
export async function handleListVersions(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const orgId = getOrgId(req);
  const orgRole = getOrgRole(req);

  if (!isAdmin(orgRole)) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Organization admin role required' },
    });
    return;
  }

  const statusFilter = (req.query.status as string) || 'pending_review';
  if (!VALID_STATUSES.includes(statusFilter as VersionStatus)) {
    res.status(400).json({
      error: { code: 'invalid_request', message: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}` },
    });
    return;
  }

  try {
    const { data, error } = await db
      .from('external_document_versions')
      .select('id, external_file_id, source, fingerprint, version_number, status, metadata, detected_at')
      .eq('org_id', orgId!)
      .eq('status', statusFilter)
      .order('detected_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error({ error }, 'Failed to list external_document_versions');
      res.status(500).json({
        error: { code: 'internal', message: 'Failed to list versions' },
      });
      return;
    }

    res.json({ versions: data ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'handleListVersions unexpected error');
    res.status(500).json({
      error: { code: 'internal', message: 'Internal server error' },
    });
  }
}

/**
 * POST /api/v1/versions/:versionId/resolve
 * Admin resolves a version conflict:
 * - approve: update status + create PENDING anchor for the new fingerprint
 * - skip: update status only
 * - flag: update status only
 * All decisions insert a row into version_reviews.
 */
export async function handleResolveVersion(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const orgId = getOrgId(req);
  const orgRole = getOrgRole(req);

  if (!isAdmin(orgRole)) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Organization admin role required' },
    });
    return;
  }

  const parsed = ResolveVersionInput.safeParse(req.body);
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

  const { versionId } = req.params;
  const { decision, notes } = parsed.data;

  try {
    // Look up the version — filter by org_id ensures cross-tenant isolation
    const { data: version, error: lookupError } = await db
      .from('external_document_versions')
      .select('id, external_file_id, fingerprint, org_id, source, metadata')
      .eq('id', versionId)
      .eq('org_id', orgId!)
      .maybeSingle();

    if (lookupError) {
      logger.error({ error: lookupError, versionId }, 'Version lookup failed');
      res.status(500).json({
        error: { code: 'internal', message: 'Internal server error' },
      });
      return;
    }

    if (!version) {
      res.status(404).json({
        error: { code: 'not_found', message: 'Version not found' },
      });
      return;
    }

    // Map decision to version status
    const statusMap: Record<string, string> = {
      approve: 'approved',
      skip: 'skipped',
      flag: 'flagged',
    };
    const newStatus = statusMap[decision];

    // Update version status
    const { error: updateError } = await db
      .from('external_document_versions')
      .update({ status: newStatus, reviewed_at: new Date().toISOString(), reviewed_by: userId })
      .eq('id', versionId)
      .eq('org_id', orgId!)
      .select('id')
      .single();

    if (updateError) {
      logger.error({ error: updateError, versionId }, 'Version status update failed');
      res.status(500).json({
        error: { code: 'internal', message: 'Failed to update version status' },
      });
      return;
    }

    // On approve: create a PENDING anchor for the new fingerprint
    if (decision === 'approve') {
      const { error: anchorError } = await db
        .from('anchors')
        .insert({
          org_id: orgId,
          external_file_id: version.external_file_id,
          fingerprint: version.fingerprint,
          status: 'PENDING',
          source: version.source ?? 'version_resolution',
          created_by: userId,
        })
        .select('id, public_id')
        .single();

      if (anchorError) {
        logger.error({ error: anchorError, versionId }, 'Anchor creation failed during version approval');
        // Non-fatal: version is already approved, log but don't fail the request
      }
    }

    // Record the review decision
    const { error: reviewError } = await db
      .from('version_reviews')
      .insert({
        version_id: versionId,
        org_id: orgId,
        reviewer_id: userId,
        decision,
        notes: notes ?? null,
      });

    if (reviewError) {
      logger.warn({ error: reviewError, versionId }, 'version_reviews insert failed (non-fatal)');
    }

    res.json({
      success: true,
      decision,
      version_id: versionId,
    });
  } catch (err) {
    logger.error({ error: err, versionId }, 'handleResolveVersion unexpected error');
    res.status(500).json({
      error: { code: 'internal', message: 'Internal server error' },
    });
  }
}

// ─── Router ──────���────────────────────────────────���────────────────────────────

export const versionResolutionRouter = Router();
versionResolutionRouter.get('/', handleListVersions);
versionResolutionRouter.post('/:versionId/resolve', handleResolveVersion);
