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
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { EMERGENCY_ACCESS_MAX_HOURS } from '../../constants/hipaa.js';
import { requireOrgId } from '../../middleware/requireOrgId.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

export const emergencyAccessRouter = Router();

emergencyAccessRouter.use(requireOrgId);

export const RequestSchema = z.object({
  reason: z.string().min(10).max(2000),
  scope: z.string().default('healthcare_credentials'),
  duration_hours: z.number().min(0.5).max(EMERGENCY_ACCESS_MAX_HOURS).default(EMERGENCY_ACCESS_MAX_HOURS),
});

export const RevokeSchema = z.object({
  reason: z.string().min(1).max(2000).optional(),
});

// ─── POST / — Request emergency access ──────────────────────────────────────

emergencyAccessRouter.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
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
        org_id: req.orgId,
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

    void dbAny.from('audit_events').insert({
      event_type: 'EMERGENCY_ACCESS_REQUESTED',
      event_category: 'SECURITY',
      actor_id: userId,
      org_id: req.orgId,
      target_type: 'emergency_access_grant',
      target_id: data.id,
      details: JSON.stringify({ reason, scope, duration_hours, expires_at: expiresAt }),
    });

    logger.info({ grantId: data.id, userId, orgId: req.orgId }, 'Emergency access requested');

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

// ─── PATCH /:id/approve — Dual-control approval ────────────────────────────

emergencyAccessRouter.patch('/:id/approve', async (req: Request, res: Response) => {
  try {
    const approverId = req.authUserId;
    if (!approverId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { id } = req.params;

    const { data: grant, error: fetchError } = await dbAny
      .from('emergency_access_grants')
      .select('grantee_id, expires_at, revoked_at')
      .eq('id', id)
      .eq('org_id', req.orgId)
      .single();

    if (fetchError || !grant) {
      res.status(404).json({ error: 'Grant not found' });
      return;
    }

    if (grant.grantee_id === approverId) {
      res.status(403).json({ error: 'Cannot approve your own emergency access request (dual-control requirement)' });
      return;
    }

    if (grant.revoked_at) {
      res.status(409).json({ error: 'Grant has already been revoked' });
      return;
    }

    if (new Date(grant.expires_at) < new Date()) {
      res.status(409).json({ error: 'Grant has expired' });
      return;
    }

    const { error: updateError } = await dbAny
      .from('emergency_access_grants')
      .update({ approver_id: approverId })
      .eq('id', id);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to approve emergency access');
      res.status(500).json({ error: 'Failed to approve' });
      return;
    }

    void dbAny.from('audit_events').insert({
      event_type: 'EMERGENCY_ACCESS_APPROVED',
      event_category: 'SECURITY',
      actor_id: approverId,
      org_id: req.orgId,
      target_type: 'emergency_access_grant',
      target_id: id,
      details: JSON.stringify({ grantee_id: grant.grantee_id, expires_at: grant.expires_at }),
    });

    logger.info({ grantId: id, approverId, orgId: req.orgId }, 'Emergency access approved');

    res.json({ id, status: 'approved', approved_by: approverId, expires_at: grant.expires_at });
  } catch (err) {
    logger.error({ err }, 'Emergency access approve error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /:id/revoke ─────────────────────────────────────────────────────

emergencyAccessRouter.patch('/:id/revoke', async (req: Request, res: Response) => {
  try {
    const revokerId = req.authUserId;
    if (!revokerId) {
      res.status(401).json({ error: 'Authentication required' });
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
      .eq('org_id', req.orgId)
      .is('revoked_at', null)
      .select('id, revoked_at')
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Grant not found or already revoked' });
      return;
    }

    void dbAny.from('audit_events').insert({
      event_type: 'EMERGENCY_ACCESS_REVOKED',
      event_category: 'SECURITY',
      actor_id: revokerId,
      org_id: req.orgId,
      target_type: 'emergency_access_grant',
      target_id: id,
      details: JSON.stringify({ revoke_reason: revokeReason }),
    });

    logger.info({ grantId: id, revokerId, orgId: req.orgId }, 'Emergency access revoked');

    res.json({ id, status: 'revoked', revoked_at: data.revoked_at });
  } catch (err) {
    logger.error({ err }, 'Emergency access revoke error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET / ──────────────────────────────────────────────────────────────────

emergencyAccessRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { data, error } = await dbAny
      .from('emergency_access_grants')
      .select('id, org_id, grantee_id, approver_id, scope, granted_at, expires_at, revoked_at, created_at')
      .eq('org_id', req.orgId)
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
