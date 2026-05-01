import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { requireScopeV2 } from './scopeGuard.js';
import { ProblemError } from './problem.js';
import { createV2ScopeRateLimit } from './rateLimit.js';

export const agentToolsRouter = Router();

const PUBLIC_ID_RE = /^ARK-[A-Z0-9-]{3,60}$/;
const SHA256_HEX_RE = /^[a-fA-F0-9]{64}$/;

interface V2QueryBuilder {
  select(columns: string): V2QueryBuilder;
  eq(column: string, value: string): V2QueryBuilder;
  in(column: string, values: string[]): V2QueryBuilder;
  is(column: string, value: null): V2QueryBuilder;
  or(filter: string): V2QueryBuilder;
  order(column: string, options: { ascending: boolean }): V2QueryBuilder;
  limit(count: number): V2QueryBuilder;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
}

const v2Db = db as unknown as {
  from(table: string): V2QueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
};

function sanitizeFilterValue(v: string): string {
  return v.replace(/[%_\\,().]/g, c => `\\${c}`);
}

function visibleAnchorScope(orgId: string | null | undefined): string {
  return orgId
    ? `status.eq.SECURED,org_id.eq.${sanitizeFilterValue(orgId)}`
    : 'status.eq.SECURED';
}

function pathParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function mapPublicAnchor(row: Record<string, unknown>, publicId: string): Record<string, unknown> {
  const status = (row.status as string | undefined) ?? 'UNKNOWN';
  return {
    public_id: publicId,
    verified: status === 'SECURED' || status === 'ACTIVE',
    status: status === 'SECURED' ? 'ACTIVE' : status,
    issuer_name: row.org_name ?? 'Unknown',
    credential_type: row.credential_type ?? 'UNKNOWN',
    issued_date: row.issued_at ?? null,
    expiry_date: row.expires_at ?? null,
    anchor_timestamp: row.created_at ?? null,
    network_receipt_id: row.chain_tx_id ?? null,
    record_uri: `https://app.arkova.ai/verify/${publicId}`,
    jurisdiction: row.jurisdiction ?? undefined,
  };
}

agentToolsRouter.get(
  '/verify/:fingerprint',
  requireScopeV2('read:records'),
  createV2ScopeRateLimit('read:records'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const fingerprint = pathParam(req.params.fingerprint);
    if (!fingerprint || !SHA256_HEX_RE.test(fingerprint)) {
      next(ProblemError.validationError('fingerprint must be a 64-character SHA-256 hex string'));
      return;
    }

    try {
      const { data, error } = await v2Db.from('anchors')
        .select('id, public_id, fingerprint, filename, status, created_at, chain_tx_id')
        .eq('fingerprint', fingerprint.toLowerCase())
        .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
        .is('deleted_at', null)
        .or(visibleAnchorScope(req.apiKey?.orgId))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error({ error }, 'v2 verify tool lookup failed');
        next(ProblemError.internalError('Failed to verify fingerprint.'));
        return;
      }

      if (!data) {
        res.json({
          verified: false,
          status: 'UNKNOWN',
          fingerprint: fingerprint.toLowerCase(),
          public_id: null,
          anchor_timestamp: null,
          network_receipt_id: null,
          record_uri: null,
        });
        return;
      }

      const status = data.status as string | null;
      const publicId = data.public_id as string | null;
      res.json({
        verified: status === 'SECURED',
        status: status === 'SECURED' ? 'ACTIVE' : status,
        fingerprint: data.fingerprint,
        public_id: publicId,
        title: data.filename ?? null,
        anchor_timestamp: data.created_at,
        network_receipt_id: data.chain_tx_id ?? null,
        record_uri: publicId ? `https://app.arkova.ai/verify/${publicId}` : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

agentToolsRouter.get(
  '/anchors/:publicId',
  requireScopeV2('read:records'),
  createV2ScopeRateLimit('read:records'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const publicId = pathParam(req.params.publicId);
    if (!publicId || !PUBLIC_ID_RE.test(publicId)) {
      next(ProblemError.validationError('public_id must match ARK-<TYPE>-<SUFFIX>'));
      return;
    }

    try {
      const { data, error } = await v2Db.rpc('get_public_anchor', {
        p_public_id: publicId,
      });

      if (error || !data || (data as Record<string, unknown>).error) {
        next(ProblemError.notFound(`Anchor ${publicId} was not found.`));
        return;
      }

      res.json(mapPublicAnchor(data as Record<string, unknown>, publicId));
    } catch (err) {
      next(err);
    }
  },
);

agentToolsRouter.get(
  '/orgs',
  requireScopeV2('read:orgs'),
  createV2ScopeRateLimit('read:orgs'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.apiKey?.orgId) {
      next(ProblemError.authenticationRequired());
      return;
    }

    try {
      const { data, error } = await v2Db.from('organizations')
        .select('public_id, display_name, domain, website_url, verification_status')
        .eq('id', req.apiKey.orgId)
        .maybeSingle();

      if (error) {
        logger.error({ error }, 'v2 list_orgs lookup failed');
        next(ProblemError.internalError('Failed to list organizations.'));
        return;
      }

      res.json({
        organizations: data ? [{
          public_id: typeof data.public_id === 'string' ? data.public_id : null,
          display_name: data.display_name,
          domain: data.domain,
          website_url: data.website_url,
          verification_status: data.verification_status,
        }] : [],
      });
    } catch (err) {
      next(err);
    }
  },
);
