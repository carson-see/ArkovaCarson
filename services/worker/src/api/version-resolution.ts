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
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { getCallerProfile, isCallerOrgAdmin } from './_org-auth.js';

// Tables created by migration 0323 are not yet in generated types.
// Use untyped accessor until next `gen:types` run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untypedDb = db as unknown as SupabaseClient<any, 'public', any>;

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

async function resolveOrgAdminContext(
  req: Request,
  userId: string,
): Promise<{ orgId: string | null; isAdmin: boolean }> {
  const requestOrgId = getOrgId(req);
  const requestRole = getOrgRole(req);
  if (requestOrgId && requestRole !== null) {
    return { orgId: requestOrgId, isAdmin: isAdmin(requestRole) };
  }
  if (requestOrgId) {
    return { orgId: requestOrgId, isAdmin: await isCallerOrgAdmin(userId, requestOrgId) };
  }

  const profile = await getCallerProfile(userId);
  const profileOrgId = profile?.org_id ?? null;
  if (!profileOrgId) return { orgId: null, isAdmin: false };
  return {
    orgId: profileOrgId,
    isAdmin: await isCallerOrgAdmin(userId, profileOrgId, profile),
  };
}

export async function requireVersionOrgAdminContext(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { orgId, isAdmin: isOrgAdmin } = await resolveOrgAdminContext(req, userId);
  if (!orgId) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Organization context required' },
    });
    return;
  }

  if (!isOrgAdmin) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Organization admin role required' },
    });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).orgId = orgId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).orgRole = 'admin';
  next();
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

  const { orgId, isAdmin: isOrgAdmin } = await resolveOrgAdminContext(req, userId);

  if (!orgId) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Organization context required' },
    });
    return;
  }

  if (!isOrgAdmin) {
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
    const { data, error } = await untypedDb
      .from('external_document_versions')
      .select('id, external_file_id, source, fingerprint, version_number, status, metadata, detected_at')
      .eq('org_id', orgId)
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

  const { orgId, isAdmin: isOrgAdmin } = await resolveOrgAdminContext(req, userId);

  if (!orgId) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Organization context required' },
    });
    return;
  }

  if (!isOrgAdmin) {
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

  const versionIdParsed = z.string().uuid().safeParse(req.params.versionId);
  if (!versionIdParsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'Invalid versionId: must be a UUID' },
    });
    return;
  }
  const versionId = versionIdParsed.data;
  const { decision, notes } = parsed.data;

  try {
    // Look up the version — filter by org_id ensures cross-tenant isolation.
    // Only pending_review items can be resolved (prevents duplicate processing).
    const { data: version, error: lookupError } = await untypedDb
      .from('external_document_versions')
      .select('id, external_file_id, fingerprint, org_id, source, metadata, status')
      .eq('id', versionId)
      .eq('org_id', orgId)
      .eq('status', 'pending_review')
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

    // Update version status — include status predicate to prevent double-resolution
    // if two admins race to approve the same version concurrently.
    const { data: updatedVersion, error: updateError } = await untypedDb
      .from('external_document_versions')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', versionId)
      .eq('org_id', orgId)
      .eq('status', 'pending_review')
      .select('id')
      .maybeSingle();

    if (updateError) {
      logger.error({ error: updateError, versionId }, 'Version status update failed');
      res.status(500).json({
        error: { code: 'internal', message: 'Failed to update version status' },
      });
      return;
    }

    if (!updatedVersion) {
      res.status(409).json({
        error: { code: 'conflict', message: 'Version was already resolved' },
      });
      return;
    }

    // On approve: create a PENDING anchor for the new fingerprint.
    // If anchor creation fails, revert the status update to avoid partial writes.
    if (decision === 'approve') {
      const { data: anchor, error: anchorError } = await db
        .from('anchors')
        .insert({
          org_id: orgId,
          fingerprint: version.fingerprint,
          filename: version.external_file_id,
          status: 'PENDING',
          user_id: userId,
          metadata: {
            source: version.source ?? 'version_resolution',
            external_file_id: version.external_file_id,
            resolved_from_version: versionId,
          },
        })
        .select('id, public_id')
        .single();

      if (anchorError) {
        logger.error({ error: anchorError, versionId }, 'Anchor creation failed during version approval');
        // Revert status to pending_review to avoid inconsistent state
        const { data: rollbackVersion, error: rollbackError } = await untypedDb
          .from('external_document_versions')
          .update({ status: 'pending_review', updated_at: new Date().toISOString() })
          .eq('id', versionId)
          .eq('org_id', orgId)
          .select('id')
          .maybeSingle();
        if (rollbackError || !rollbackVersion) {
          logger.error(
            { error: rollbackError, versionId, rollbackRestored: Boolean(rollbackVersion) },
            'Version status rollback failed after anchor creation failure',
          );
        }
        res.status(500).json({
          error: { code: 'internal', message: 'Failed to create anchor for approved version' },
        });
        return;
      }

      if (anchor?.id) {
        const { error: anchorLinkError } = await untypedDb
          .from('external_document_versions')
          .update({ anchor_id: anchor.id, updated_at: new Date().toISOString() })
          .eq('id', versionId)
          .eq('org_id', orgId);

        if (anchorLinkError) {
          logger.error({ error: anchorLinkError, versionId }, 'Approved version anchor link update failed');
          res.status(500).json({
            error: { code: 'internal', message: 'Failed to link approved version to anchor' },
          });
          return;
        }
      }
    }

    // Record the review decision
    const { error: reviewError } = await untypedDb
      .from('version_reviews')
      .insert({
        version_id: versionId,
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
