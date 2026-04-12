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
import { buildVerificationResult } from './verify.js';
import type { AnchorByPublicId } from './verify.js';

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
    // Batch lookup anchors
    const { data: anchors, error: fetchError } = await db
      .from('anchors')
      .select(`
        public_id, fingerprint, status, chain_tx_id, chain_block_height,
        chain_timestamp, created_at, credential_type, issued_at, expires_at,
        org_id, description
      `)
      .in('public_id', public_ids)
      .is('deleted_at', null);

    if (fetchError) {
      logger.error({ error: fetchError, queryId }, 'Oracle batch lookup failed');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const anchorMap = new Map<string, Record<string, unknown>>();
    for (const a of (anchors ?? [])) {
      anchorMap.set(a.public_id as string, a);
    }

    // Resolve org names for all unique org_ids
    const orgIds = [...new Set((anchors ?? []).map((a) => a.org_id).filter((id): id is string => id != null))];
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

    // Audit trail — log every oracle query
    void db.from('audit_events').insert({
      event_type: 'ORACLE_QUERY',
      event_category: 'ANCHOR',
      target_type: 'oracle',
      target_id: queryId,
      details: JSON.stringify({
        agent_key_id: agentKeyId,
        public_ids_queried: public_ids.length,
        verified_count: results.filter((r) => r.verified).length,
        not_found_count: results.filter((r) => r.error === 'Record not found').length,
      }),
    });

    res.json(oracleResult);
  } catch (err) {
    logger.error({ error: err, queryId }, 'Oracle query failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as oracleRouter };
