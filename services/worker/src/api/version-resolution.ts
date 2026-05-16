/**
 * Version Resolution API (SCRUM-1971 / SCRUM-1126)
 *
 * POST /:versionId/resolve — Resolve a version conflict
 *   Body: { decision: 'approve' | 'skip' | 'flag', notes?: string }
 *
 * On approve: creates a PENDING anchor for the new fingerprint
 * On skip: marks version as resolved, no anchor created
 * On flag: marks for escalation, emits notification
 *
 * Admin-only: requires org admin/owner role for the version's org.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';

export const versionResolutionRouter = Router();

const ResolveBodySchema = z.object({
  decision: z.enum(['approve', 'skip', 'flag']),
  notes: z.string().max(2000).optional(),
});

const ParamsSchema = z.object({
  versionId: z.string().uuid(),
});

versionResolutionRouter.post('/:versionId/resolve', async (req: Request<{ versionId: string }>, res: Response) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
    return;
  }

  const paramsParsed = ParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: 'validation_error', message: 'Invalid versionId — must be a UUID.' });
    return;
  }

  const bodyParsed = ResolveBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({
      error: 'validation_error',
      message: bodyParsed.error.issues.map(i => i.message).join('; '),
    });
    return;
  }

  const { versionId } = paramsParsed.data;
  const { decision, notes } = bodyParsed.data;

  try {
    // Fetch the version record
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: version, error: fetchError } = await (db as any)
      .from('external_document_versions')
      .select('id, org_id, status, fingerprint, external_file_id, filename')
      .eq('id', versionId)
      .single();

    if (fetchError || !version) {
      res.status(404).json({ error: 'not_found', message: 'Version not found.' });
      return;
    }

    // Admin/owner check: verify user is admin/owner of this org
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: membership } = await (db as any)
      .from('org_members')
      .select('role')
      .eq('user_id', userId)
      .eq('org_id', version.org_id)
      .single();

    if (!membership || !['admin', 'owner'].includes(membership.role)) {
      res.status(403).json({ error: 'forbidden', message: 'Admin or owner role required.' });
      return;
    }

    // Record the review decision
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('version_reviews')
      .insert({
        version_id: versionId,
        org_id: version.org_id,
        reviewer_id: userId,
        decision,
        notes: notes ?? null,
      });

    // Map decision to version status
    const statusMap = { approve: 'approved', skip: 'skipped', flag: 'flagged' } as const;
    const newStatus = statusMap[decision];

    // Update version status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('external_document_versions')
      .update({ status: newStatus })
      .eq('id', versionId);

    // Decision-specific side effects
    if (decision === 'approve') {
      // Create a PENDING anchor for the new fingerprint
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any)
        .from('anchors')
        .insert({
          org_id: version.org_id,
          fingerprint: version.fingerprint,
          filename: version.filename ?? 'Unknown',
          status: 'PENDING',
          metadata: {
            source: 'version_resolution',
            version_id: versionId,
            external_file_id: version.external_file_id,
          },
        });
    }

    if (decision === 'flag') {
      await emitOrgAdminNotifications({
        type: 'document.version_conflict',
        organizationId: version.org_id,
        payload: {
          version_id: versionId,
          decision: 'flag',
          notes: notes ?? null,
          flagged_by: userId,
        },
      });
    }

    logger.info({ versionId, decision, userId, orgId: version.org_id }, 'Version resolved');

    res.status(200).json({
      success: true,
      decision,
      version_id: versionId,
      status: newStatus,
    });
  } catch (error) {
    logger.error({ error, versionId, userId }, 'Version resolution failed');
    res.status(500).json({ error: 'internal_error', message: 'Resolution failed.' });
  }
});
