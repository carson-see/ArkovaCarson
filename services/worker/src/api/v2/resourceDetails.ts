import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { requireScopeV2 } from './scopeGuard.js';
import { ProblemError } from './problem.js';
import { createV2ScopeRateLimit } from './rateLimit.js';
import { PUBLIC_ANCHOR_ID_RE, PUBLIC_ORG_ID_RE, SHA256_HEX_RE, visibleAnchorScope } from './resourceIdentifiers.js';

export const resourceDetailsRouter = Router();

const ANCHOR_DETAIL_COLUMNS = [
  'public_id',
  'filename',
  'description',
  'credential_type',
  'sub_type',
  'status',
  'fingerprint',
  'created_at',
  'chain_timestamp',
  'chain_tx_id',
  'issued_at',
  'expires_at',
  'metadata',
].join(', ');

const SAFE_METADATA_KEYS = new Set([
  'issuer',
  'title',
  'source',
  'source_id',
  'source_url',
  'jurisdiction',
  'credential_type',
  'sub_type',
  'issued_date',
  'expiry_date',
]);

interface V2QueryBuilder {
  select(columns: string): V2QueryBuilder;
  eq(column: string, value: string): V2QueryBuilder;
  in(column: string, values: string[]): V2QueryBuilder;
  is(column: string, value: null): V2QueryBuilder;
  not(column: string, operator: string, value: null): V2QueryBuilder;
  or(filter: string): V2QueryBuilder;
  order(column: string, options: { ascending: boolean }): V2QueryBuilder;
  limit(count: number): V2QueryBuilder;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
}

const v2Db = db as unknown as {
  from(table: string): V2QueryBuilder;
};

function pathParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || value === null
    ) {
      output[key] = value;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeAnchorStatus(status: unknown): string {
  return status === 'SECURED' ? 'ACTIVE' : (stringOrNull(status) ?? 'UNKNOWN');
}

function mapAnchorDetail(row: Record<string, unknown>, type: 'record' | 'fingerprint' | 'document') {
  const publicId = stringOrNull(row.public_id);
  const recordUri = publicId ? `https://app.arkova.ai/verify/${publicId}` : null;
  const status = row.status;

  return {
    type,
    public_id: publicId,
    verified: status === 'SECURED',
    status: normalizeAnchorStatus(status),
    title: stringOrNull(row.filename),
    description: stringOrNull(row.description),
    credential_type: stringOrNull(row.credential_type),
    sub_type: stringOrNull(row.sub_type),
    fingerprint: stringOrNull(row.fingerprint),
    issued_date: stringOrNull(row.issued_at),
    expiry_date: stringOrNull(row.expires_at),
    anchor_timestamp: stringOrNull(row.chain_timestamp) ?? stringOrNull(row.created_at),
    network_receipt_id: stringOrNull(row.chain_tx_id),
    record_uri: recordUri,
    metadata: safeMetadata(row.metadata),
  };
}

async function loadVisibleAnchorByPublicId(publicId: string, orgId: string | null | undefined) {
  return v2Db.from('anchors')
    .select(ANCHOR_DETAIL_COLUMNS)
    .eq('public_id', publicId)
    .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
    .is('deleted_at', null)
    .not('public_id', 'is', null)
    .or(visibleAnchorScope(orgId))
    .maybeSingle();
}

async function loadVisibleAnchorByFingerprint(fingerprint: string, orgId: string | null | undefined) {
  return v2Db.from('anchors')
    .select(ANCHOR_DETAIL_COLUMNS)
    .eq('fingerprint', fingerprint.toLowerCase())
    .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
    .is('deleted_at', null)
    .not('public_id', 'is', null)
    .or(visibleAnchorScope(orgId))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

function buildAnchorDetailHandler(type: 'record' | 'document') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const publicId = pathParam(req.params.publicId);
    if (!publicId || !PUBLIC_ANCHOR_ID_RE.test(publicId)) {
      next(ProblemError.validationError('public_id must match ARK-<TYPE>-<SUFFIX>'));
      return;
    }

    try {
      const { data, error } = await loadVisibleAnchorByPublicId(publicId, req.apiKey?.orgId);
      if (error) {
        logger.error({ error }, `v2 ${type} detail lookup failed`);
        next(ProblemError.internalError(`Failed to fetch ${type} detail.`));
        return;
      }
      if (!data) {
        next(ProblemError.notFound(`${type} ${publicId} was not found.`));
        return;
      }

      res.json(mapAnchorDetail(data, type));
    } catch (err) {
      next(err);
    }
  };
}

resourceDetailsRouter.get(
  '/organizations/:publicId',
  requireScopeV2('read:orgs'),
  createV2ScopeRateLimit('read:orgs'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const publicId = pathParam(req.params.publicId);
    if (!publicId || !PUBLIC_ORG_ID_RE.test(publicId)) {
      next(ProblemError.validationError('organization public_id is invalid'));
      return;
    }
    if (!req.apiKey?.orgId) {
      next(ProblemError.authenticationRequired());
      return;
    }

    try {
      const { data, error } = await v2Db.from('organizations')
        .select('public_id, display_name, description, domain, website_url, verification_status')
        .eq('id', req.apiKey.orgId)
        .eq('public_id', publicId)
        .maybeSingle();

      if (error) {
        logger.error({ error }, 'v2 organization detail lookup failed');
        next(ProblemError.internalError('Failed to fetch organization detail.'));
        return;
      }
      if (!data) {
        next(ProblemError.notFound(`organization ${publicId} was not found.`));
        return;
      }

      res.json({
        public_id: data.public_id,
        display_name: data.display_name,
        description: data.description ?? null,
        domain: data.domain ?? null,
        website_url: data.website_url ?? null,
        verification_status: data.verification_status ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

resourceDetailsRouter.get(
  '/records/:publicId',
  requireScopeV2('read:records'),
  createV2ScopeRateLimit('read:records'),
  buildAnchorDetailHandler('record'),
);

resourceDetailsRouter.get(
  '/fingerprints/:fingerprint',
  requireScopeV2('read:records'),
  createV2ScopeRateLimit('read:records'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const fingerprint = pathParam(req.params.fingerprint);
    if (!fingerprint || !SHA256_HEX_RE.test(fingerprint)) {
      next(ProblemError.validationError('fingerprint must be a 64-character SHA-256 hex string'));
      return;
    }

    try {
      const { data, error } = await loadVisibleAnchorByFingerprint(fingerprint, req.apiKey?.orgId);
      if (error) {
        logger.error({ error }, 'v2 fingerprint detail lookup failed');
        next(ProblemError.internalError('Failed to fetch fingerprint detail.'));
        return;
      }
      if (!data) {
        next(ProblemError.notFound(`fingerprint ${fingerprint.toLowerCase()} was not found.`));
        return;
      }

      res.json(mapAnchorDetail(data, 'fingerprint'));
    } catch (err) {
      next(err);
    }
  },
);

resourceDetailsRouter.get(
  '/documents/:publicId',
  requireScopeV2('read:records'),
  createV2ScopeRateLimit('read:records'),
  buildAnchorDetailHandler('document'),
);
