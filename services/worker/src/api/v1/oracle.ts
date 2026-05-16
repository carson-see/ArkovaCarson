/**
 * Record Authenticity Oracle (PH2-AGENT-04)
 *
 * POST /api/v1/oracle/verify
 *
 * Agent-callable endpoint that returns signed, auditable verification
 * responses. Unlike GET /api/v1/verify/:publicId (public, anonymous),
 * this endpoint:
 *   - Requires an API key (identifies the querying agent)
 *   - Returns agent metadata in the response (agent_key_id, query_id)
 *   - Logs a full audit trail entry per query
 *   - Supports batch queries (up to 25 IDs per request)
 *   - Returns an HMAC signature over the response for tamper detection
 *
 * Roadmap: Phase II — Agentic Verification Layer
 * Constitution 1.8: Additive fields only (no breaking changes to frozen schema)
 */

import { Router, Request, Response } from 'express';
import { createHmac, randomUUID } from 'crypto';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { buildVerificationResult, EMPTY_API_RICH_FIELDS } from './verify.js';
import type { AnchorByPublicId } from './verify.js';
import { dispatchWebhookEvent } from '../../webhooks/delivery.js';
import { runWithConcurrency } from '../../utils/concurrency.js';

const router = Router();

const OracleQuerySchema = z.object({
  public_ids: z.array(z.string().min(3).max(64)).min(1).max(25),
});

export interface OracleResult {
  query_id: string;
  agent_key_id: string | null;
  queried_at: string;
  results: OracleVerification[];
  signature: string;
}

interface OracleVerification {
  public_id: string;
  verified: boolean;
  status?: string;
  issuer_name?: string;
  credential_type?: string;
  anchor_timestamp?: string;
  network_receipt_id?: string | null;
  explorer_url?: string;
  error?: string;
}

/**
 * POST /api/v1/oracle/verify
 *
 * Body: { public_ids: ["ARK-...", "ARK-..."] }
 * Returns: signed batch verification with agent metadata
 */
router.post('/verify', async (req: Request, res: Response) => {
  const queryId = randomUUID();
  const agentKeyId = req.apiKey?.keyId ?? null;
  const queriedAt = new Date().toISOString();

  // Validate input
  const parsed = OracleQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: parsed.error.issues.map((i) => i.message),
    });
    return;
  }

  const { public_ids } = parsed.data;

  try {
    const { data: anchors, error: fetchError } = await db
      .from('anchors')
      .select('public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, created_at, credential_type, issued_at, expires_at, org_id, description, directory_info_opt_out')
      .in('public_id', public_ids)
      .is('deleted_at', null);

    if (fetchError) {
      logger.error({ error: fetchError, queryId }, 'Oracle batch lookup failed');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const anchorList = (anchors ?? []) as Array<Record<string, unknown>>;
    const anchorMap = new Map<string, Record<string, unknown>>();
    for (const a of anchorList) {
      anchorMap.set(a.public_id as string, a);
    }

    const orgIds = [...new Set(anchorList.map((a) => a.org_id).filter((id): id is string => id != null))] as string[];
    const orgNameMap = new Map<string, string>();
    if (orgIds.length > 0) {
      const { data: orgs } = await db
        .from('organizations')
        .select('id, display_name')
        .in('id', orgIds);
      for (const org of (orgs ?? [])) {
        orgNameMap.set(org.id, org.display_name);
      }
    }

    // Build results
    const results: OracleVerification[] = public_ids.map((pid) => {
      const raw = anchorMap.get(pid);
      if (!raw) {
        return { public_id: pid, verified: false, error: 'Record not found' };
      }

      const anchor: AnchorByPublicId = {
        public_id: raw.public_id as string,
        fingerprint: raw.fingerprint as string,
        status: raw.status as string,
        org_id: (raw.org_id as string | null) ?? null, // SCRUM-1799 internal-only
        chain_tx_id: (raw.chain_tx_id as string) ?? null,
        chain_block_height: (raw.chain_block_height as number) ?? null,
        chain_timestamp: (raw.chain_timestamp as string) ?? null,
        created_at: raw.created_at as string,
        credential_type: (raw.credential_type as string) ?? null,
        org_name: raw.org_id ? (orgNameMap.get(raw.org_id as string) ?? null) : null,
        recipient_hash: null,
        issued_at: (raw.issued_at as string) ?? null,
        expires_at: (raw.expires_at as string) ?? null,
        jurisdiction: null,
        merkle_root: null,
        description: (raw.description as string) ?? null,
        directory_info_opt_out: (raw.directory_info_opt_out as boolean) ?? false,
        // Oracle endpoint is batch + terse by design — rich fields stay null to keep
        // per-row payload small. Clients that need richness call GET /verify/{publicId}.
        ...EMPTY_API_RICH_FIELDS,
      };

      const full = buildVerificationResult(anchor);
      return {
        public_id: pid,
        verified: full.verified,
        status: full.status,
        issuer_name: full.issuer_name,
        credential_type: full.credential_type,
        anchor_timestamp: full.anchor_timestamp,
        network_receipt_id: full.network_receipt_id,
        explorer_url: full.explorer_url,
      };
    });

    // Sign response with HMAC for tamper detection (Constitution 1.4: never hardcode secrets)
    const payload = JSON.stringify({ query_id: queryId, results });
    const hmacSecret = process.env.API_KEY_HMAC_SECRET;
    if (!hmacSecret) {
      logger.error('API_KEY_HMAC_SECRET not configured — cannot sign oracle responses');
      res.status(500).json({ error: 'Oracle signing not configured' });
      return;
    }
    const signature = createHmac('sha256', hmacSecret)
      .update(payload)
      .digest('hex');

    const oracleResult: OracleResult = {
      query_id: queryId,
      agent_key_id: agentKeyId,
      queried_at: queriedAt,
      results,
      signature,
    };

    // SCRUM-1799 (SCRUM-1743 Phase 2b): credential.verified emit on oracle
    // batch verifications. Same gating + cache-MISS semantics as the public
    // GET /api/v1/verify/:publicId path — but oracle is intrinsically batch +
    // does NOT consult the verify cache (each call is a fresh DB lookup), so
    // every successful, terminal-status result becomes an emit candidate.
    //
    // Rate safety: capped at 25 ids per request (OracleQuerySchema). Fan-out
    // uses the shared concurrency helper (default 5) so one large batch
    // doesn't spike webhook delivery for the org.
    //
    // Default-OFF feature flag: ENABLE_CREDENTIAL_VERIFIED_WEBHOOK. The audit
    // count of dispatched/skipped emits lands in the existing ORACLE_QUERY
    // audit row's details so the trail matches what was actually attempted.
    // _planned = candidates count (queued for fan-out); _skipped = anchors
    // ineligible to emit (not found, no org_id, non-terminal status). Both are
    // resolved synchronously before the audit write so the audit row is
    // accurate even though the fan-out itself is detached.
    let credentialVerifiedPlanned = 0;
    let credentialVerifiedSkipped = 0;
    if (config.enableCredentialVerifiedWebhook) {
      type EmitCandidate = {
        publicId: string;
        orgId: string;
        credentialType: string;
        terminalStatus: 'SECURED' | 'REVOKED' | 'EXPIRED';
      };
      const candidates: EmitCandidate[] = [];
      for (const pid of public_ids) {
        const raw = anchorMap.get(pid);
        if (!raw) {
          credentialVerifiedSkipped++;
          continue;
        }
        const orgId = raw.org_id as string | null;
        if (!orgId) {
          credentialVerifiedSkipped++;
          continue;
        }
        const status = raw.status as string;
        const terminalStatus =
          status === 'SECURED' || status === 'ACTIVE' ? 'SECURED' as const
          : status === 'REVOKED' ? 'REVOKED' as const
          : status === 'EXPIRED' ? 'EXPIRED' as const
          : null;
        if (!terminalStatus) {
          credentialVerifiedSkipped++;
          continue;
        }
        const credentialType = (raw.credential_type as string | null) ?? 'OTHER';
        candidates.push({ publicId: pid, orgId, credentialType, terminalStatus });
      }
      credentialVerifiedPlanned = candidates.length;
      if (candidates.length > 0) {
        const verifiedAt = new Date().toISOString();
        const tasks = candidates.map((cand) => async () => {
          try {
            await dispatchWebhookEvent(cand.orgId, 'credential.verified', cand.publicId, {
              public_id: cand.publicId,
              credential_type: cand.credentialType,
              status: cand.terminalStatus,
              verified_at: verifiedAt,
            });
          } catch (emitErr) {
            logger.warn(
              { queryId, publicId: cand.publicId, error: emitErr },
              'Oracle credential.verified emit failed (response NOT aborted)',
            );
          }
        });
        // Detached: oracle response is signed + ready; webhook fan-out should
        // not block the agent's verify result. Bounded concurrency keeps the
        // outbound dispatch from overwhelming a customer endpoint.
        void runWithConcurrency(tasks, 5).catch((fanOutErr) => {
          logger.error(
            { queryId, error: fanOutErr },
            'Detached oracle credential.verified fan-out unexpectedly threw',
          );
        });
      }
    }

    // Audit trail — log every oracle query
    void db.from('audit_events').insert({
      event_type: 'ORACLE_QUERY',
      event_category: 'ANCHOR',
      org_id: req.apiKey?.orgId ?? undefined,
      target_type: 'oracle',
      target_id: queryId,
      details: JSON.stringify({
        agent_key_id: agentKeyId,
        public_ids_queried: public_ids.length,
        verified_count: results.filter((r) => r.verified).length,
        not_found_count: results.filter((r) => r.error === 'Record not found').length,
        // SCRUM-1799: capture the credential.verified emit decision counts so
        // auditors can correlate webhook deliveries to the originating batch.
        // `_planned` reflects the number of dispatch tasks queued; the actual
        // delivery outcome is in webhook_delivery_logs.
        credential_verified_emit_planned: credentialVerifiedPlanned,
        credential_verified_emit_skipped: credentialVerifiedSkipped,
      }),
    });

    res.json(oracleResult);
  } catch (err) {
    logger.error({ error: err, queryId }, 'Oracle query failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as oracleRouter };
