import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { emitNotification } from '../notifications/dispatcher.js';

export const anchorRevokeRouter = Router();

const RevokeSchema = z.object({
  reason: z.string().min(1).max(1000),
});

anchorRevokeRouter.post('/:id/revoke', async (req: Request, res: Response) => {
  const anchorId = req.params.id;
  const parsed = RevokeSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      message: parsed.error.issues.map(i => i.message).join('; '),
    });
    return;
  }

  const { reason } = parsed.data;

  try {
    const { data: anchor, error: fetchError } = await db.from('anchors')
      .select('id, status, org_id, user_id')
      .eq('id', anchorId)
      .single();

    if (fetchError || !anchor) {
      res.status(404).json({ error: 'not_found', message: 'Anchor not found.' });
      return;
    }

    if (anchor.status !== 'SECURED') {
      res.status(409).json({
        error: 'invalid_state',
        message: `Cannot revoke anchor in ${anchor.status} status. Only SECURED anchors can be revoked.`,
      });
      return;
    }

    const { error: rpcError } = await db.rpc('revoke_anchor', {
      anchor_id: anchorId,
      reason,
    });

    if (rpcError) {
      logger.error({ error: rpcError, anchorId }, 'revoke_anchor RPC failed');
      res.status(500).json({ error: 'revocation_failed', message: 'Failed to revoke anchor.' });
      return;
    }

    db.from('audit_events').insert({
      event_type: 'anchor.revoked',
      entity_type: 'anchor',
      entity_id: anchorId,
      org_id: anchor.org_id,
      user_id: anchor.user_id,
      metadata: { reason, revoked_at: new Date().toISOString() },
    }).then(({ error }) => {
      if (error) logger.error({ error, anchorId }, 'Failed to write revocation audit event');
    });

    void emitNotification({
      type: 'anchor_revoked',
      userId: anchor.user_id,
      organizationId: anchor.org_id,
      payload: { anchorId, reason },
    });

    logger.info({ anchorId, reason }, 'Anchor revoked');
    res.json({ success: true, anchorId, status: 'REVOKED' });
  } catch (err) {
    logger.error({ error: err, anchorId }, 'Revocation endpoint failed');
    res.status(500).json({ error: 'internal_error', message: 'Revocation failed.' });
  }
});
