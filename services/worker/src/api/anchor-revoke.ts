import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { emitNotification } from '../notifications/dispatcher.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';

export const anchorRevokeRouter = Router();

const RevokeSchema = z.object({
  reason: z.string().min(1).max(1000),
});

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

const NOT_FOUND_RESPONSE = { error: 'not_found', message: 'Anchor not found.' } as const;

anchorRevokeRouter.post('/:id/revoke', async (req: Request<{ id: string }>, res: Response) => {
  const paramsParsed = ParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({
      error: 'validation_error',
      message: 'Invalid anchor id.',
    });
    return;
  }
  const anchorId = paramsParsed.data.id;

  const parsed = RevokeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      message: parsed.error.issues.map(i => i.message).join('; '),
    });
    return;
  }

  const { reason } = parsed.data;

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
    return;
  }

  try {
    const { data: anchor, error: fetchError } = await db.from('anchors')
      // SCRUM-1800: also fetch public_id + credential_type + chain_tx_id +
      // chain_block_height for the credential.status_changed and anchor.revoked
      // webhook payloads.
      .select('id, public_id, status, org_id, user_id, credential_type, chain_tx_id, chain_block_height')
      .eq('id', anchorId)
      .single();

    if (fetchError || !anchor) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }

    // Orphan anchors (no org_id) bypass the membership scope check; treat
    // as not-found rather than letting the membership query match on
    // org_id IS NULL.
    if (!anchor.org_id) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }

    // PR #753 (no-shortcuts directive): the table is named `memberships`,
    // not `org_memberships`. The worker code had `org_memberships` which
    // returns PGRST205 "table not found" → data: undefined → !membership →
    // 404 for every revoke attempt. Pre-existing prod bug surfaced while
    // exercising Trigger B during the T3 staging soak. The unit tests
    // passed because they mock the query, so neither CI nor the previous
    // T2 soak (which only exercised Trigger A / expiry sweep) caught it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not yet in generated database.types.ts
    const { data: membership, error: membershipError } = await (db as any).from('memberships')
      .select('role')
      .eq('user_id', userId)
      .eq('org_id', anchor.org_id)
      .single();

    // PR #753 audit fix A5: distinguish "no row" (legit 404) from "error"
    // (DB outage / RLS regression / >1 row from missing UNIQUE constraint).
    // The pre-fix `if (!membership)` collapsed all of these into 404, so a
    // user with a duplicate-membership row would see "Anchor not found"
    // instead of a 500 — silently misleading.
    if (membershipError) {
      const code = (membershipError as { code?: string }).code;
      if (code !== 'PGRST116') {
        // Real error (not "no row matched"). 500, log, surface to operator.
        logger.error(
          { error: membershipError, userId, orgId: anchor.org_id },
          'Membership lookup failed (not no-row)',
        );
        res.status(500).json({ error: 'membership_lookup_failed', message: 'Membership lookup failed.' });
        return;
      }
      // PGRST116 = no row matched, fall through to !membership 404 below.
    }

    if (!membership) {
      res.status(404).json(NOT_FOUND_RESPONSE);
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

    // CodeRabbit PR #753 (SCRUM-1800): use the DB-committed `revoked_at`
    // timestamp rather than `new Date().toISOString()` so the audit row,
    // anchor.revoked webhook, and credential.status_changed webhook all
    // agree on the same authoritative moment-of-revocation. Per CLAUDE.md
    // §1.5 (server timestamps in Postgres timestamptz, UTC). Falls back to
    // the app clock if the re-read fails (rare; the row was just updated).
    let revokedAtIso = new Date().toISOString();
    try {
      const { data: revokedRow, error: rereadErr } = await db
        .from('anchors')
        .select('revoked_at')
        .eq('id', anchorId)
        .single();
      if (!rereadErr && revokedRow?.revoked_at) {
        revokedAtIso = revokedRow.revoked_at as string;
      } else if (rereadErr) {
        logger.warn(
          { anchorId, error: rereadErr },
          'Re-read of anchors.revoked_at failed after revoke_anchor RPC; falling back to app clock for audit + webhook timestamps',
        );
      }
    } catch (rereadErr) {
      logger.warn(
        { anchorId, error: rereadErr },
        'Re-read of anchors.revoked_at threw after revoke_anchor RPC; falling back to app clock',
      );
    }

    db.from('audit_events').insert({
      event_type: 'anchor.revoked',
      event_category: 'ANCHOR',
      actor_id: userId,
      org_id: anchor.org_id,
      target_type: 'anchor',
      target_id: anchorId,
      details: JSON.stringify({ reason, revoked_at: revokedAtIso }),
    }).then(({ error }) => {
      if (error) logger.error({ error, anchorId }, 'Failed to write revocation audit event');
    });

    void emitNotification({
      type: 'anchor_revoked',
      userId: anchor.user_id,
      organizationId: anchor.org_id ?? undefined,
      payload: { anchorId, reason },
    });

    // SCRUM-1800 (SCRUM-1743 Phase 2c): emit credential.status_changed on
    // SECURED → REVOKED transition. Best-effort (best-effort dispatch in a
    // try/catch; failure logs warn but does NOT abort the response).
    //
    // Companion: emit anchor.revoked too — its schema lives in
    // PAYLOAD_SCHEMAS_BY_EVENT_TYPE but no producer was wired, so subscribed
    // customers never received deliveries. SCRUM-1800 adds the producer.
    if (anchor.public_id && anchor.org_id) {
      // Reuse the DB-committed timestamp from the audit row above so the
      // anchor.revoked + credential.status_changed webhook payloads agree
      // with the audit trail (CodeRabbit PR #753).
      const changedAt = revokedAtIso;
      let anchorRevokedDispatched = false;
      let anchorRevokedError: string | null = null;
      try {
        await dispatchWebhookEvent(anchor.org_id, 'anchor.revoked', anchor.public_id, {
          public_id: anchor.public_id,
          status: 'REVOKED',
          chain_tx_id: anchor.chain_tx_id ?? null,
          chain_block_height: anchor.chain_block_height ?? null,
          revoked_at: changedAt,
          revocation_reason: reason,
        });
        anchorRevokedDispatched = true;
      } catch (webhookError) {
        anchorRevokedError = webhookError instanceof Error
          ? webhookError.message
          : String(webhookError);
        logger.warn({ anchorId, error: webhookError }, 'Failed to dispatch anchor.revoked webhook');
      }

      if (anchor.credential_type) {
        let credStatusDispatched = false;
        let credStatusError: string | null = null;
        try {
          await dispatchWebhookEvent(anchor.org_id, 'credential.status_changed', anchor.public_id, {
            public_id: anchor.public_id,
            credential_type: anchor.credential_type,
            previous_status: 'SECURED',
            new_status: 'REVOKED',
            changed_at: changedAt,
            reason,
          });
          credStatusDispatched = true;
        } catch (webhookError) {
          credStatusError = webhookError instanceof Error
            ? webhookError.message
            : String(webhookError);
          logger.warn({ anchorId, error: webhookError }, 'Failed to dispatch credential.status_changed webhook');
        }

        // SCRUM-1800: emit-decision audit row for credential.status_changed.
        // Companion to the existing anchor.revoked audit row (line ~100). Lets
        // auditors filter `event_type='credential.status_changed'` directly
        // without joining webhook_delivery_logs.
        db.from('audit_events').insert({
          event_type: 'credential.status_changed',
          event_category: 'WEBHOOK',
          actor_id: userId,
          org_id: anchor.org_id,
          target_type: 'anchor',
          target_id: anchorId,
          details: JSON.stringify({
            public_id: anchor.public_id,
            credential_type: anchor.credential_type,
            previous_status: 'SECURED',
            new_status: 'REVOKED',
            dispatched: credStatusDispatched,
            dispatch_error: credStatusError,
            reason,
          }),
        }).then(({ error }) => {
          if (error) {
            logger.error({ error, anchorId }, 'Failed to write credential.status_changed audit row');
          }
        });
      }

      // SCRUM-1800: emit-decision audit row for anchor.revoked. The existing
      // `anchor.revoked` audit row at line ~100 captures the actor revocation
      // action; this row separately captures the webhook dispatch outcome so a
      // delivery failure surfaces in the audit feed too.
      db.from('audit_events').insert({
        event_type: 'anchor.revoked.dispatched',
        event_category: 'WEBHOOK',
        actor_id: userId,
        org_id: anchor.org_id,
        target_type: 'anchor',
        target_id: anchorId,
        details: JSON.stringify({
          public_id: anchor.public_id,
          dispatched: anchorRevokedDispatched,
          dispatch_error: anchorRevokedError,
        }),
      }).then(({ error }) => {
        if (error) {
          logger.error({ error, anchorId }, 'Failed to write anchor.revoked.dispatched audit row');
        }
      });
    }

    logger.info({ anchorId, reason }, 'Anchor revoked');
    res.json({ success: true, anchorId, status: 'REVOKED' });
  } catch (err) {
    logger.error({ error: err, anchorId }, 'Revocation endpoint failed');
    res.status(500).json({ error: 'internal_error', message: 'Revocation failed.' });
  }
});
