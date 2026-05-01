import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { requireScopeV2 } from './scopeGuard.js';
import { ProblemError } from './problem.js';
import { createV2ScopeRateLimit } from './rateLimit.js';

export const resourceDetailsRouter = Router();

const ORG_PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,100}$/;
const PUBLIC_ID_RE = /^ARK-[A-Z0-9-]{3,60}$/;
const SHA256_HEX_RE = /^[a-fA-F0-9]{64}$/;
const VERIFY_BASE_URL = 'https://app.arkova.ai/verify';

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

interface AnchorDetailRoute {
  path: string;
  label: string;
  mapRow: (row: Record<string, unknown>) => Record<string, unknown>;
}

const v2Db = db as unknown as {
  from(table: string): V2QueryBuilder;
};

function sanitizeFilterValue(v: string): string {
  return v.replaceAll(/[%_\\,().]/g, (c) => `\\${c}`);
}

function visibleAnchorScope(orgId: string | null | undefined): string {
  return orgId
    ? `status.eq.SECURED,org_id.eq.${sanitizeFilterValue(orgId)}`
    : 'status.eq.SECURED';
}

function pathParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedObject(row: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = row[key];
  if (Array.isArray(value)) return objectOrNull(value[0]);
  return objectOrNull(value);
}

function normalizeAnchorStatus(status: string | null): string {
  return status === 'SECURED' ? 'ACTIVE' : (status ?? 'UNKNOWN');
}

function isVerifiedStatus(status: string | null): boolean {
  return status === 'SECURED' || status === 'ACTIVE';
}

function recordUri(publicId: string | null): string | null {
  return publicId ? `${VERIFY_BASE_URL}/${publicId}` : null;
}

function validation(message: string): ProblemError {
  return ProblemError.validationError(message);
}

function anchorSelectColumns(): string {
  return [
    'public_id',
    'fingerprint',
    'filename',
    'description',
    'credential_type',
    'sub_type',
    'status',
    'created_at',
    'issued_at',
    'expires_at',
    'chain_tx_id',
    'chain_confirmations',
    'compliance_controls',
    'version_number',
    'revocation_tx_id',
    'revocation_block_height',
    'file_mime',
    'file_size',
    'organization:org_id(display_name)',
    'parent:parent_anchor_id(public_id)',
  ].join(', ');
}

function mapOrganizationDetail(row: Record<string, unknown>): Record<string, unknown> {
  return {
    public_id: row.public_id,
    display_name: row.display_name,
    description: row.description ?? null,
    domain: row.domain ?? null,
    website_url: row.website_url ?? null,
    verification_status: row.verification_status ?? null,
    industry_tag: row.industry_tag ?? null,
    org_type: row.org_type ?? null,
    location: row.location ?? null,
    logo_url: row.logo_url ?? null,
  };
}

function mapRecordDetail(row: Record<string, unknown>): Record<string, unknown> {
  const publicId = stringOrNull(row.public_id);
  const status = stringOrNull(row.status);
  const organization = nestedObject(row, 'organization');
  const parent = nestedObject(row, 'parent');

  return {
    public_id: publicId,
    verified: isVerifiedStatus(status),
    status: normalizeAnchorStatus(status),
    fingerprint: row.fingerprint ?? null,
    title: row.filename ?? null,
    description: row.description ?? null,
    issuer_name: organization?.display_name ?? null,
    credential_type: row.credential_type ?? null,
    sub_type: row.sub_type ?? null,
    issued_date: row.issued_at ?? null,
    expiry_date: row.expires_at ?? null,
    anchor_timestamp: row.created_at ?? null,
    network_receipt_id: row.chain_tx_id ?? null,
    record_uri: recordUri(publicId),
    compliance_controls: objectOrNull(row.compliance_controls),
    chain_confirmations: numberOrNull(row.chain_confirmations),
    parent_public_id: stringOrNull(parent?.public_id),
    version_number: numberOrNull(row.version_number),
    revocation_tx_id: row.revocation_tx_id ?? null,
    revocation_block_height: numberOrNull(row.revocation_block_height),
  };
}

function mapDocumentDetail(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...mapRecordDetail(row),
    file_mime: row.file_mime ?? null,
    file_size: numberOrNull(row.file_size),
  };
}

function mapFingerprintDetail(row: Record<string, unknown>, fingerprint: string): Record<string, unknown> {
  const detail = mapRecordDetail(row);
  return {
    verified: detail.verified,
    status: detail.status,
    fingerprint,
    public_id: detail.public_id,
    title: detail.title,
    issuer_name: detail.issuer_name,
    credential_type: detail.credential_type,
    sub_type: detail.sub_type,
    description: detail.description,
    anchor_timestamp: detail.anchor_timestamp,
    network_receipt_id: detail.network_receipt_id,
    record_uri: detail.record_uri,
    compliance_controls: detail.compliance_controls,
    chain_confirmations: detail.chain_confirmations,
    parent_public_id: detail.parent_public_id,
    version_number: detail.version_number,
    revocation_tx_id: detail.revocation_tx_id,
    revocation_block_height: detail.revocation_block_height,
    file_mime: row.file_mime ?? null,
    file_size: numberOrNull(row.file_size),
  };
}

async function lookupAnchorByPublicId(
  publicId: string,
  orgId: string | null | undefined,
): Promise<{ data: Record<string, unknown> | null; error: unknown }> {
  return v2Db.from('anchors')
    .select(anchorSelectColumns())
    .eq('public_id', publicId)
    .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
    .is('deleted_at', null)
    .or(visibleAnchorScope(orgId))
    .maybeSingle();
}

function registerAnchorDetailRoute(route: AnchorDetailRoute): void {
  const lookupLabel = route.label.toLowerCase();
  resourceDetailsRouter.get(
    route.path,
    requireScopeV2('read:records'),
    createV2ScopeRateLimit('read:records'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const publicId = pathParam(req.params.publicId);
      if (!publicId || !PUBLIC_ID_RE.test(publicId)) {
        next(validation('public_id must match ARK-<TYPE>-<SUFFIX>'));
        return;
      }

      try {
        const { data, error } = await lookupAnchorByPublicId(publicId, req.apiKey?.orgId);
        if (error) {
          logger.error({ error }, `v2 ${lookupLabel} detail lookup failed`);
          next(ProblemError.internalError(`Failed to load ${lookupLabel} detail.`));
          return;
        }
        if (!data) {
          next(ProblemError.notFound(`${route.label} ${publicId} was not found.`));
          return;
        }

        res.json(route.mapRow(data));
      } catch (err) {
        next(err);
      }
    },
  );
}

resourceDetailsRouter.get(
  '/organizations/:publicId',
  requireScopeV2('read:orgs'),
  createV2ScopeRateLimit('read:orgs'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const publicId = pathParam(req.params.publicId);
    if (!publicId || !ORG_PUBLIC_ID_RE.test(publicId)) {
      next(validation('organization public_id must be a stable organization public identifier'));
      return;
    }
    if (!req.apiKey?.orgId) {
      next(ProblemError.authenticationRequired());
      return;
    }

    try {
      const { data, error } = await v2Db.from('organizations')
        .select('public_id, display_name, description, domain, website_url, verification_status, industry_tag, org_type, location, logo_url')
        .eq('id', req.apiKey.orgId)
        .eq('public_id', publicId)
        .maybeSingle();

      if (error) {
        logger.error({ error }, 'v2 organization detail lookup failed');
        next(ProblemError.internalError('Failed to load organization detail.'));
        return;
      }
      if (!data) {
        next(ProblemError.notFound(`Organization ${publicId} was not found.`));
        return;
      }

      res.json(mapOrganizationDetail(data));
    } catch (err) {
      next(err);
    }
  },
);

registerAnchorDetailRoute({ path: '/records/:publicId', label: 'Record', mapRow: mapRecordDetail });
registerAnchorDetailRoute({ path: '/documents/:publicId', label: 'Document', mapRow: mapDocumentDetail });

resourceDetailsRouter.get(
  '/fingerprints/:fingerprint',
  requireScopeV2('read:records'),
  createV2ScopeRateLimit('read:records'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const fingerprint = pathParam(req.params.fingerprint);
    if (!fingerprint || !SHA256_HEX_RE.test(fingerprint)) {
      next(validation('fingerprint must be a 64-character SHA-256 hex string'));
      return;
    }

    try {
      const normalizedFingerprint = fingerprint.toLowerCase();
      const { data, error } = await v2Db.from('anchors')
        .select(anchorSelectColumns())
        .eq('fingerprint', normalizedFingerprint)
        .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
        .is('deleted_at', null)
        .not('public_id', 'is', null)
        .or(visibleAnchorScope(req.apiKey?.orgId))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error({ error }, 'v2 fingerprint detail lookup failed');
        next(ProblemError.internalError('Failed to load fingerprint detail.'));
        return;
      }
      if (!data) {
        next(ProblemError.notFound(`Fingerprint ${normalizedFingerprint} was not found.`));
        return;
      }

      res.json(mapFingerprintDetail(data, normalizedFingerprint));
    } catch (err) {
      next(err);
    }
  },
);
