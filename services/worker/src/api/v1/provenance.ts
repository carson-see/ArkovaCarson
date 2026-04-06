/**
 * Credential Provenance Timeline API (COMP-02)
 *
 * GET /api/v1/verify/:publicId/provenance — Returns the complete chain of custody
 * for a credential as an ordered array of events with timestamps and evidence refs.
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

interface ProvenanceEvent {
  event_type: string;
  timestamp: string;
  detail: string;
  evidence_ref?: string;
  actor?: string;
}

router.get('/:publicId/provenance', async (req: Request, res: Response) => {
  try {
    const { publicId } = req.params;

    // Fetch anchor
    const { data: anchor, error } = await db
      .from('anchors')
      .select('id, public_id, fingerprint, status, created_at, submitted_at, secured_at, tx_id, batch_id, org_id, revoked_at, revocation_reason')
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !anchor) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    const events: ProvenanceEvent[] = [];

    // 1. Document uploaded / anchor created
    events.push({
      event_type: 'credential_created',
      timestamp: anchor.created_at,
      detail: `Credential ${anchor.public_id} created with fingerprint ${anchor.fingerprint?.substring(0, 16)}...`,
    });

    // 2. Submitted to network (if applicable)
    if (anchor.submitted_at) {
      const delay = new Date(anchor.submitted_at).getTime() - new Date(anchor.created_at).getTime();
      events.push({
        event_type: 'anchor_submitted',
        timestamp: anchor.submitted_at,
        detail: `Submitted to anchoring pipeline${delay > 0 ? ` (${Math.round(delay / 60000)}min after creation)` : ''}`,
        evidence_ref: anchor.batch_id || undefined,
      });
    }

    // 3. Secured on network
    if (anchor.secured_at) {
      const delay = anchor.submitted_at
        ? new Date(anchor.secured_at).getTime() - new Date(anchor.submitted_at).getTime()
        : 0;
      events.push({
        event_type: 'network_confirmed',
        timestamp: anchor.secured_at,
        detail: `Confirmed on public network${delay > 0 ? ` (${Math.round(delay / 60000)}min after submission)` : ''}`,
        evidence_ref: anchor.tx_id || undefined,
      });
    }

    // 4. Fetch signature events (Phase III)
    const { data: signatures } = await (db as any)
      .from('signatures')
      .select('public_id, format, level, status, signed_at, signer_name, timestamp_token_id')
      .eq('anchor_id', anchor.id)
      .order('created_at', { ascending: true });

    if (signatures) {
      for (const sig of signatures) {
        if (sig.signed_at) {
          events.push({
            event_type: 'signature_created',
            timestamp: sig.signed_at,
            detail: `${sig.format} ${sig.level} signature by ${sig.signer_name || 'unknown'}`,
            evidence_ref: sig.public_id,
          });
        }
        if (sig.timestamp_token_id) {
          events.push({
            event_type: 'timestamp_acquired',
            timestamp: sig.signed_at || sig.created_at,
            detail: `RFC 3161 timestamp token acquired for signature ${sig.public_id}`,
            evidence_ref: sig.timestamp_token_id,
          });
        }
      }
    }

    // 5. Fetch verification events from audit trail
    const { data: verifyEvents } = await db
      .from('audit_events')
      .select('event_type, created_at, metadata')
      .eq('resource_id', anchor.id)
      .in('event_type', ['VERIFICATION_QUERY', 'signature.verified'])
      .order('created_at', { ascending: true })
      .limit(50);

    if (verifyEvents) {
      for (const evt of verifyEvents) {
        events.push({
          event_type: 'verification_query',
          timestamp: evt.created_at,
          detail: 'Third-party verification request',
        });
      }
    }

    // 6. Revocation
    if (anchor.revoked_at) {
      events.push({
        event_type: 'credential_revoked',
        timestamp: anchor.revoked_at,
        detail: `Revoked: ${anchor.revocation_reason || 'no reason provided'}`,
      });
    }

    // Sort by timestamp
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Flag anomalies
    const anomalies: string[] = [];
    if (anchor.submitted_at && anchor.secured_at) {
      const confirmDelay = new Date(anchor.secured_at).getTime() - new Date(anchor.submitted_at).getTime();
      if (confirmDelay > 24 * 3600_000) {
        anomalies.push(`Confirmation delay: ${Math.round(confirmDelay / 3600_000)}h (expected <1h)`);
      }
    }
    if (anchor.status === 'PENDING') {
      const age = Date.now() - new Date(anchor.created_at).getTime();
      if (age > 48 * 3600_000) {
        anomalies.push(`Stale PENDING: ${Math.round(age / 3600_000)}h without anchoring`);
      }
    }

    res.json({
      public_id: anchor.public_id,
      status: anchor.status,
      events,
      anomalies,
      event_count: events.length,
    });
  } catch (err) {
    logger.error('Provenance timeline failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as provenanceRouter };
