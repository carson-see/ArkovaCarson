/**
 * HIPAA Emergency Access API — REG-10 (SCRUM-571)
 *
 * POST   /api/v1/emergency-access           — Request emergency access
 * PATCH  /api/v1/emergency-access/:id/approve — Approve (dual-control)
 * PATCH  /api/v1/emergency-access/:id/revoke  — Revoke early
 * GET    /api/v1/emergency-access            — List grants for org
 *
 * Section 164.312(a)(2)(ii): Emergency access procedure.
 * Time-limited, dual-control approved, fully logged.
 * Default: 4 hours maximum duration.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

export const emergencyAccessRouter = Router();

const MAX_DURATION_HOURS = 4;

const RequestSchema = z.object({
  reason: z.string().min(10).max(2000),
  scope: z.string().default('healthcare_credentials'),
  duration_hours: z.number().min(0.5).max(MAX_DURATION_HOURS).default(MAX_DURATION_HOURS),
});

const RevokeSchema = z.object({
  reason: z.string().min(1).max(2000).optional(),
});

// ─── POST /api/v1/emergency-access — Request ────────────────────────────────

emergencyAccessRouter.post('/', async (req: Request, res: Response) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    const userId = req.authUserId;
    if (!orgId || !userId) {
      res.status(400).json({ error: 'x-org-id header and authentication required' });
      return;
    }

    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { reason, scope, duration_hours } = parsed.data;
    const expiresAt = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();

    const { data, error } = await dbAny
      .from('emergency_access_grants')
      .insert({
        org_id: orgId,
        grantee_id: userId,
        reason,
        scope,
        expires_at: expiresAt,
      })
      .select('id, granted_at, expires_at, scope')
      .single();

    if (error) {
      logger.error({ error }, 'Failed to create emergency access request');
      res.status(500).json({ error: 'Failed to create request' });
      return;
    }

    // Audit log
    void dbAny.from('audit_events').insert({
      event_type: 'EMERGENCY_ACCESS_REQUESTED',
      event_category: 'SECURITY',
      actor_id: userId,
      org_id: orgId,
      target_type: 'emergency_access_grant',
      target_id: data.id,
      details: JSON.stringify({ reason, scope, duration_hours, expires_at: expiresAt }),
    });

    logger.info({ grantId: data.id, userId, orgId }, 'Emergency access requested');

    res.status(201).json({
      id: data.id,
      status: 'pending_approval',
      granted_at: data.granted_at,
      expires_at: data.expires_at,
      scope: data.scope,
      message: 'Emergency access requested. Awaiting administrator approval.',
    });
  } catch (err) {
    logger.error({ err }, 'Emergency access request error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/v1/emergency-access/:id/approve — Dual-control ──────────────

emergencyAccessRouter.patch('/:id/approve', async (req: Request, res: Response) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    const approverId = req.authUserId;
    if (!orgId || !approverId) {
      res.status(400).json({ error: 'x-org-id header and authentication required' });
      return;
    }

    const { id } = req.params;

    // Fetch the grant
    const { data: grant, error: fetchError } = await dbAny
      .from('emergency_access_grants')
      .select('*')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();

    if (fetchError || !grant) {
      res.status(404).json({ error: 'Grant not found' });
      return;
    }

    // Dual-control: approver must be different from grantee
    if (grant.grantee_id === approverId) {
      res.status(403).json({ error: 'Cannot approve your own emergency access request (dual-control requirement)' });
      return;
    }

    // Check not already revoked
    if (grant.revoked_at) {
      res.status(409).json({ error: 'Grant has already been revoked' });
      return;
    }

    // Check not expired
    if (new Date(grant.expires_at) < new Date()) {
      res.status(409).json({ error: 'Grant has expired' });
      return;
    }

    // Approve
    const { error: updateError } = await dbAny
      .from('emergency_access_grants')
      .update({ approver_id: approverId })
      .eq('id', id);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to approve emergency access');
      res.status(500).json({ error: 'Failed to approve' });
      return;
    }

    // Audit log
    void dbAny.from('audit_events').insert({
      event_type: 'EMERGENCY_ACCESS_APPROVED',
      event_category: 'SECURITY',
      actor_id: approverId,
      org_id: orgId,
      target_type: 'emergency_access_grant',
      target_id: id,
      details: JSON.stringify({ grantee_id: grant.grantee_id, expires_at: grant.expires_at }),
    });

    logger.info({ grantId: id, approverId, orgId }, 'Emergency access approved');

    res.json({
      id,
      status: 'approved',
      approved_by: approverId,
      expires_at: grant.expires_at,
    });
  } catch (err) {
    logger.error({ err }, 'Emergency access approve error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/v1/emergency-access/:id/revoke ──────────────────────────────

emergencyAccessRouter.patch('/:id/revoke', async (req: Request, res: Response) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    const revokerId = req.authUserId;
    if (!orgId || !revokerId) {
      res.status(400).json({ error: 'x-org-id header and authentication required' });
      return;
    }

    const { id } = req.params;
    const parsed = RevokeSchema.safeParse(req.body);
    const revokeReason = parsed.success ? parsed.data.reason : undefined;

    const { data, error } = await dbAny
      .from('emergency_access_grants')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: revokerId,
        revoke_reason: revokeReason ?? 'Manual revocation',
      })
      .eq('id', id)
      .eq('org_id', orgId)
      .is('revoked_at', null)
      .select('id, revoked_at')
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Grant not found or already revoked' });
      return;
    }

    // Audit log
    void dbAny.from('audit_events').insert({
      event_type: 'EMERGENCY_ACCESS_REVOKED',
      event_category: 'SECURITY',
      actor_id: revokerId,
      org_id: orgId,
      target_type: 'emergency_access_grant',
      target_id: id,
      details: JSON.stringify({ revoke_reason: revokeReason }),
    });

    logger.info({ grantId: id, revokerId, orgId }, 'Emergency access revoked');

    res.json({ id, status: 'revoked', revoked_at: data.revoked_at });
  } catch (err) {
    logger.error({ err }, 'Emergency access revoke error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/emergency-access ───────────────────────────────────────────

emergencyAccessRouter.get('/', async (req: Request, res: Response) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const { data, error } = await dbAny
      .from('emergency_access_grants')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      logger.error({ error }, 'Failed to list emergency access grants');
      res.status(500).json({ error: 'Failed to list grants' });
      return;
    }

    res.json({ grants: data ?? [] });
  } catch (err) {
    logger.error({ err }, 'Emergency access list error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
