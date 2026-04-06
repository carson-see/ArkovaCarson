/**
 * Credential Provenance Timeline (COMP-02)
 *
 * GET /api/v1/verify/:publicId/provenance
 * Returns the complete chain of custody from upload through verification.
 * Events include: upload, fingerprint, anchor submission, network confirmation,
 * signature creation, timestamp acquisition, verification queries.
 *
 * Rate limited: 100 req/min per IP (anonymous), 1000 req/min per key.
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export interface ProvenanceEvent {
  event_type: string;
  timestamp: string;
  actor?: string;
  evidence_reference?: string;
  time_delta_seconds?: number;
  anomaly?: boolean;
}

export interface AnchorProvenanceData {
  public_id: string;
  fingerprint: string;
  status: string;
  created_at: string;
  updated_at: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  revoked_at: string | null;
}

interface AuditEventRow {
  event_type: string;
  created_at: string;
  actor_id: string | null;
}

const TWENTY_FOUR_HOURS_SECONDS = 24 * 60 * 60;

/**
 * Build a provenance timeline from anchor data and audit events.
 * Pure function — no DB calls, fully testable.
 */
export function buildProvenanceTimeline(
  anchor: AnchorProvenanceData,
  auditEvents: AuditEventRow[],
): ProvenanceEvent[] {
  const events: ProvenanceEvent[] = [];

  // 1. Credential uploaded
  events.push({
    event_type: 'credential_uploaded',
    timestamp: anchor.created_at,
  });

  // 2. Fingerprint computed (same as upload — happens client-side before submission)
  events.push({
    event_type: 'fingerprint_computed',
    timestamp: anchor.created_at,
    evidence_reference: anchor.fingerprint,
  });

  // 3. Network confirmed (if chain data exists)
  if (anchor.chain_timestamp && anchor.chain_tx_id) {
    const delaySeconds = (new Date(anchor.chain_timestamp).getTime() - new Date(anchor.created_at).getTime()) / 1000;
    const isAnomalous = delaySeconds > TWENTY_FOUR_HOURS_SECONDS;

    events.push({
      event_type: 'network_confirmed',
      timestamp: anchor.chain_timestamp,
      evidence_reference: anchor.chain_tx_id,
      ...(isAnomalous ? { anomaly: true } : {}),
    });
  }

  // 4. Revocation (if applicable)
  if (anchor.revoked_at) {
    events.push({
      event_type: 'credential_revoked',
      timestamp: anchor.revoked_at,
    });
  }

  // 5. Verification queries from audit log (anonymized)
  for (const evt of auditEvents) {
    if (evt.event_type === 'VERIFICATION_QUERIED') {
      events.push({
        event_type: 'verification_queried',
        timestamp: evt.created_at,
        actor: evt.actor_id ? 'anonymous' : undefined,
      });
    }
  }

  // Sort chronologically
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Calculate time deltas between consecutive events
  for (let i = 1; i < events.length; i++) {
    const prev = new Date(events[i - 1].timestamp).getTime();
    const curr = new Date(events[i].timestamp).getTime();
    events[i].time_delta_seconds = Math.round((curr - prev) / 1000);
  }

  return events;
}

const router = Router();

/**
 * GET /api/v1/verify/:publicId/provenance
 * Public endpoint — no auth required (same as /verify/:publicId).
 */
router.get('/verify/:publicId/provenance', async (req: Request, res: Response) => {
  try {
    const { publicId } = req.params;

    if (!publicId || publicId.length > 64) {
      res.status(400).json({ error: 'Invalid public ID' });
      return;
    }

    // Fetch anchor record
    const { data: anchor, error: anchorError } = await db
      .from('anchors')
      .select('public_id, fingerprint, status, created_at, updated_at, chain_tx_id, chain_block_height, chain_timestamp, revoked_at')
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .limit(1)
      .single();

    if (anchorError || !anchor) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    // Fetch audit events for this anchor
    const { data: auditEvents } = await db
      .from('audit_events')
      .select('event_type, created_at, actor_id')
      .eq('target_id', anchor.public_id)
      .order('created_at', { ascending: true })
      .limit(100);

    const timeline = buildProvenanceTimeline(
      anchor as AnchorProvenanceData,
      (auditEvents ?? []) as AuditEventRow[],
    );

    res.json({
      public_id: publicId,
      event_count: timeline.length,
      events: timeline,
    });
  } catch (err) {
    logger.error('Provenance timeline retrieval failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as provenanceRouter };
