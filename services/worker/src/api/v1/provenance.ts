// @ts-nocheck — provenance aggregation query uses audit_events + anchors join
/**
 * Credential Provenance Timeline API (COMP-02)
 *
 * GET /api/v1/verify/:publicId/provenance
 *
 * Returns an ordered array of lifecycle events for a credential,
 * combining anchor state changes, signature events, and timestamp acquisitions.
 * Designed for auditors needing the full chain of custody.
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

interface ProvenanceEvent {
  event_type: string;
  timestamp: string;
  actor: string;
  evidence_reference: string | null;
  details: string | null;
}

/**
 * GET /api/v1/verify/:publicId/provenance
 * Aggregate the full provenance chain for a credential.
 */
router.get('/:publicId/provenance', async (req: Request, res: Response) => {
  try {
    const { publicId } = req.params;

    // Fetch the anchor record
    const { data: anchor, error: anchorError } = await db
      .from('anchors')
      .select('id, public_id, fingerprint, status, created_at, submitted_at, secured_at, tx_id, batch_id, org_id, revoked_at')
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (anchorError || !anchor) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    const events: ProvenanceEvent[] = [];

    // Event: Upload / Creation
    events.push({
      event_type: 'credential_created',
      timestamp: anchor.created_at,
      actor: 'system',
      evidence_reference: null,
      details: 'Document uploaded and fingerprint computed client-side',
    });

    // Event: Anchor submitted to network
    if (anchor.submitted_at) {
      events.push({
        event_type: 'anchor_submitted',
        timestamp: anchor.submitted_at,
        actor: 'system',
        evidence_reference: anchor.tx_id,
        details: 'Fingerprint submitted to anchoring network',
      });
    }

    // Event: Batch inclusion (if batched)
    if (anchor.batch_id) {
      events.push({
        event_type: 'batch_included',
        timestamp: anchor.submitted_at || anchor.created_at,
        actor: 'system',
        evidence_reference: anchor.batch_id,
        details: 'Included in batch Merkle tree for anchoring',
      });
    }

    // Event: Network confirmation
    if (anchor.secured_at) {
      events.push({
        event_type: 'network_confirmed',
        timestamp: anchor.secured_at,
        actor: 'network',
        evidence_reference: anchor.tx_id,
        details: 'Anchoring confirmed on the network',
      });
    }

    // Event: Revocation
    if (anchor.revoked_at) {
      events.push({
        event_type: 'credential_revoked',
        timestamp: anchor.revoked_at,
        actor: 'system',
        evidence_reference: null,
        details: 'Credential revoked by issuing organization',
      });
    }

    // Fetch related signatures (Phase III)
    const { data: signatures } = await db
      .from('signatures')
      .select('id, signed_at, completed_at, signer_name, format, level')
      .eq('anchor_id', anchor.id)
      .order('signed_at', { ascending: true });

    if (signatures) {
      for (const sig of signatures) {
        events.push({
          event_type: 'signature_created',
          timestamp: sig.signed_at,
          actor: sig.signer_name || 'signer',
          evidence_reference: sig.id,
          details: `${sig.format || 'AdES'} signature (${sig.level || 'B-Level'})`,
        });
        if (sig.completed_at && sig.completed_at !== sig.signed_at) {
          events.push({
            event_type: 'signature_completed',
            timestamp: sig.completed_at,
            actor: sig.signer_name || 'signer',
            evidence_reference: sig.id,
            details: 'Signature validation completed',
          });
        }
      }
    }

    // Fetch timestamp tokens (Phase III)
    const { data: timestamps } = await db
      .from('timestamp_tokens')
      .select('id, tst_gen_time, tsa_name, is_qualified')
      .eq('anchor_id', anchor.id)
      .order('tst_gen_time', { ascending: true });

    if (timestamps) {
      for (const ts of timestamps) {
        events.push({
          event_type: 'timestamp_acquired',
          timestamp: ts.tst_gen_time,
          actor: ts.tsa_name || 'TSA',
          evidence_reference: ts.id,
          details: `RFC 3161 timestamp${ts.is_qualified ? ' (qualified)' : ''}`,
        });
      }
    }

    // Fetch verification queries from audit_events
    const { data: verifyEvents } = await db
      .from('audit_events')
      .select('created_at, event_type')
      .eq('resource_type', 'anchor')
      .eq('target_id', anchor.id)
      .in('event_type', ['VERIFICATION_QUERY', 'API_VERIFY'])
      .order('created_at', { ascending: true })
      .limit(50);

    if (verifyEvents) {
      for (const ve of verifyEvents) {
        events.push({
          event_type: 'verification_query',
          timestamp: ve.created_at,
          actor: 'anonymous',
          evidence_reference: null,
          details: 'Credential verification queried',
        });
      }
    }

    // Sort all events chronologically
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Compute time deltas between events
    const eventsWithDeltas = events.map((event, i) => {
      if (i === 0) return { ...event, time_delta_seconds: null };
      const prev = new Date(events[i - 1].timestamp).getTime();
      const curr = new Date(event.timestamp).getTime();
      return { ...event, time_delta_seconds: Math.round((curr - prev) / 1000) };
    });

    // Detect anomalies
    const anomalies: string[] = [];
    if (anchor.submitted_at && anchor.secured_at) {
      const delayMs = new Date(anchor.secured_at).getTime() - new Date(anchor.submitted_at).getTime();
      if (delayMs > 24 * 3600_000) {
        anomalies.push(`Anchor delay exceeds 24 hours (${Math.round(delayMs / 3600_000)}h)`);
      }
    }
    if (anchor.status === 'PENDING') {
      const ageMs = Date.now() - new Date(anchor.created_at).getTime();
      if (ageMs > 48 * 3600_000) {
        anomalies.push(`Stale PENDING status (${Math.round(ageMs / 3600_000)}h)`);
      }
    }

    res.json({
      public_id: anchor.public_id,
      fingerprint: anchor.fingerprint,
      status: anchor.status,
      events: eventsWithDeltas,
      anomalies,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Provenance timeline generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as provenanceRouter };
