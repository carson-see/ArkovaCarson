/**
 * Credential Provenance Timeline API (COMP-02)
 *
 * GET /api/v1/verify/:publicId/provenance — Returns the complete chain of custody
 * for a credential as an ordered array of events with timestamps and evidence refs.
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isEducationCredentialType } from '../../ctdl/ctdl-pii-guard.js';
import { publicFreeTextOrNull, hasStoredFreeText } from './public-projection-text.js';

// ---------------------------------------------------------------------------
// Outbound PII gate — the FOURTH public projection of an anchor row.
//
// `router.ts` mounts this router as `router.use('/verify', provenanceRouter)`
// with NO `requireScope` and NO auth middleware, and this file has no auth
// check of its own, so EVERYTHING below reaches an anonymous caller. Three
// sibling projections of the same rows were gated first and this one was
// missed; the shared rule is
// `scripts/ci/public-pii-projection-contract.json`.
//
// TWO leaks were closed here. They needed DIFFERENT treatments, and the
// difference is the whole point:
//
//   1. `revocation_reason` — issuer-authored FREE TEXT that MIGHT contain
//      identity ("revoked - contact jane@example.edu"). Two layers, matching
//      migration 0385: academic records emit none at all (structural), every
//      other type passes the value gate.
//
//   2. `signatures.signer_name` — a person's name BY CONSTRUCTION. It is
//      populated from `cert.subject_cn` (`signatures.ts:248`), the X.509
//      Subject CN, alongside `signer_org`/`location`/`contact_info`. A value
//      detector is USELESS against it: the measured finding behind this whole
//      line of work is that no regex distinguishes a bare name from an
//      institution name. So it is handled STRUCTURALLY — the name is never
//      emitted on this projection, for any credential type, and it is not even
//      SELECTed, so the value never enters the process on this path.
//
//      What survives is everything a verifier actually needs: that a signature
//      exists, when it was made, its format and level, and an `evidence_ref`
//      (`signatures.public_id`) that resolves the signer through an
//      AUTHENTICATED surface. `format`/`level` are safe to emit unguarded —
//      both are DB CHECK-constrained closed vocabularies
//      (`signatures_format_check`, `signatures_level_check`) AND Zod-enum
//      validated at the write path, so neither can carry prose.
//
// OMISSION, NOT FAIL-CLOSED: this body answers a verification question, so a
// PII hit drops the field and the timeline still returns. Refusing would tell
// an anonymous verifier that a genuinely anchored document does not exist.
//
// NO LEARNER-NAME HEURISTIC. `containsLearnerNamePii` is deliberately not
// imported: zero measured true positives on the real leak shapes, and `for` as
// a bare preposition drops "Revoked for Non Payment", which the contract pins
// as a must-publish vector.
// ---------------------------------------------------------------------------

export interface ProvenanceEvent {
  event_type: string;
  timestamp: string;
  detail: string;
  evidence_ref?: string;
  actor?: string;
}

export interface AnchorProvenanceData {
  public_id: string;
  fingerprint: string;
  status: string;
  created_at: string;
  updated_at?: string;
  chain_tx_id?: string | null;
  chain_block_height?: number | null;
  chain_timestamp?: string | null;
  revoked_at?: string | null;
  submitted_at?: string | null;
  secured_at?: string | null;
  tx_id?: string | null;
  batch_id?: string | null;
  id?: string;
  org_id?: string | null;
  revocation_reason?: string | null;
  /**
   * Drives the structural half of the PII gate. Optional so the ~10 existing
   * hand-built fixtures in `provenance.test.ts` keep compiling; absent or
   * unrecognised means NOT an academic record, which is the correct default —
   * the value gate still runs on the reason either way.
   */
  credential_type?: string | null;
}

/**
 * Build a provenance timeline from anchor data and audit events.
 * Pure function — no DB calls, fully testable.
 */
export function buildProvenanceTimeline(
  anchor: AnchorProvenanceData,
  auditEvents: Array<{ event_type: string; created_at: string; actor_id: string | null }>,
): ProvenanceEvent[] {
  const events: ProvenanceEvent[] = [];

  // 1. Credential created
  events.push({
    event_type: 'credential_created',
    timestamp: anchor.created_at,
    detail: `Credential ${anchor.public_id} created with fingerprint ${anchor.fingerprint?.substring(0, 16)}...`,
  });

  // 2. Submitted to network
  if (anchor.submitted_at) {
    const delay = new Date(anchor.submitted_at).getTime() - new Date(anchor.created_at).getTime();
    events.push({
      event_type: 'anchor_submitted',
      timestamp: anchor.submitted_at,
      detail: `Submitted to anchoring pipeline${delay > 0 ? ` (${Math.round(delay / 60000)}min after creation)` : ''}`,
      evidence_ref: anchor.batch_id || undefined,
    });
  }

  // 3. Network confirmed
  const confirmedAt = anchor.secured_at ?? anchor.chain_timestamp;
  const txId = anchor.tx_id ?? anchor.chain_tx_id;
  if (confirmedAt) {
    const delay = anchor.submitted_at
      ? new Date(confirmedAt).getTime() - new Date(anchor.submitted_at).getTime()
      : 0;
    events.push({
      event_type: 'network_confirmed',
      timestamp: confirmedAt,
      detail: `Confirmed on public network${delay > 0 ? ` (${Math.round(delay / 60000)}min after submission)` : ''}`,
      evidence_ref: txId || undefined,
    });
  }

  // 4. Verification queries from audit trail (anonymized)
  for (const evt of auditEvents) {
    if (evt.event_type === 'VERIFICATION_QUERIED' || evt.event_type === 'VERIFICATION_QUERY') {
      events.push({
        event_type: 'verification_query',
        timestamp: evt.created_at,
        detail: 'Third-party verification request',
        actor: evt.actor_id ? 'anonymous' : undefined,
      });
    }
  }

  // 5. Revocation
  if (anchor.revoked_at) {
    // Academic records emit NO issuer-authored free text, matching migration
    // 0385, which suppresses `revocation_reason` outright for these types.
    // Unconditional — not gated on `directory_info_opt_out`, for the same
    // reason as `verify.ts`: opt-out means the default is PUBLISH, and
    // default-publish is the defect class.
    const publishableReason = isEducationCredentialType(anchor.credential_type)
      ? null
      : publicFreeTextOrNull(anchor.revocation_reason);

    // Three DISTINCT facts, three distinct strings. "no reason provided" is a
    // CLAIM, and asserting it over a reason that exists but was suppressed
    // would be false (§1.5, §1.13 R-7) — so a suppressed reason degrades to a
    // bare "Revoked", which asserts nothing about why.
    const detail =
      publishableReason ? `Revoked: ${publishableReason}`
      : hasStoredFreeText(anchor.revocation_reason) ? 'Revoked'
      : 'Revoked: no reason provided';

    events.push({
      event_type: 'credential_revoked',
      timestamp: anchor.revoked_at,
      detail,
    });
  }

  // Sort chronologically
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return events;
}

const router = Router();

router.get('/:publicId/provenance', async (req: Request<{ publicId: string }>, res: Response) => {
  try {
    const { publicId } = req.params;

    // Fetch anchor
    const { data: anchor, error } = await db
      .from('anchors')
      // `credential_type` drives the structural half of the PII gate (academic
      // records emit no issuer-authored free text). It was absent before, which
      // is why this projection could not apply the rule the other three do.
      .select('id, public_id, fingerprint, status, created_at, chain_timestamp, chain_tx_id, org_id, revoked_at, revocation_reason, credential_type')
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !anchor) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    // Fetch signature events (Phase III)
    const { data: signatures } = await (db as unknown as typeof db)
      .from('signatures')
      // `signer_name` is deliberately NOT selected. It is the X.509 Subject CN
      // (`signatures.ts:248`) — a person's name by construction — and this
      // projection is anonymous. Not fetching it means it cannot be emitted by
      // a future edit to the detail string either.
      .select('public_id, format, level, status, signed_at, timestamp_token_id, created_at')
      .eq('anchor_id', anchor.id)
      .order('created_at', { ascending: true });

    // Fetch verification events from audit trail
    // eslint-disable-next-line arkova/missing-org-filter -- scoped by target_id, ownership verified upstream
    const { data: verifyEvents } = await db
      .from('audit_events')
      .select('event_type, created_at, actor_id')
      .eq('target_id', anchor.public_id!)
      .in('event_type', ['VERIFICATION_QUERIED', 'VERIFICATION_QUERY', 'signature.verified'])
      .order('created_at', { ascending: true })
      .limit(50);

    const events = buildProvenanceTimeline(
      anchor as unknown as AnchorProvenanceData,
      (verifyEvents ?? []) as Array<{ event_type: string; created_at: string; actor_id: string | null }>,
    );

    // Add signature events from Phase III tables
    if (signatures) {
      for (const sig of signatures) {
        if (sig.signed_at) {
          events.push({
            event_type: 'signature_created',
            timestamp: sig.signed_at,
            // No signer identity on the anonymous projection — see the header
            // note. `format`/`level` are CHECK-constrained closed vocabularies,
            // and `evidence_ref` resolves the signer via an authenticated
            // surface for callers entitled to it.
            detail: `${sig.format} ${sig.level} signature`,
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

    // Re-sort after adding signature events
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Flag anomalies
    const anomalies: string[] = [];
    if (anchor.created_at && anchor.chain_timestamp) {
      const confirmDelay = new Date(anchor.chain_timestamp).getTime() - new Date(anchor.created_at).getTime();
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
    logger.error({
      error: err instanceof Error ? err.message : String(err),
    }, 'Provenance timeline failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as provenanceRouter };
