/**
 * GET /api/v1/credentials/:publicId/ctdl
 *
 * Public CTDL JSON-LD projection for an anchored credential. The endpoint
 * accepts Arkova public IDs only and intentionally returns no internal UUIDs,
 * fingerprints, raw metadata, recipient emails, or source filenames.
 */

import { Router, type Request } from 'express';
import { buildCtdlJsonLd, type CtdlAnchor } from '../../ctdl/ctdl-serializer.js';
import { isCtdlPublishableStatus } from '../../ctdl/ctdl-type-map.js';
import { buildVerifyUrl } from '../../lib/urls.js';
import { db } from '../../utils/db.js';
import { getCorrelationId } from '../../utils/correlationId.js';
import { logger } from '../../utils/logger.js';

const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CredentialsCtdlLookup {
  lookupByPublicId(publicId: string): Promise<CtdlAnchor | null>;
}

interface AuditArgs {
  req: Request;
  publicId: string;
  outcome: 'invalid' | 'not_found' | 'not_publishable' | 'published' | 'revoked' | 'error';
  httpStatus: number;
  credentialStatus?: string | null;
  credentialType?: string | null;
  orgId?: string | null;
}

function requestId(req: Request): string | null {
  const header = req.headers['x-request-id'] ?? req.headers['x-correlation-id'];
  if (typeof header === 'string') return header;
  return getCorrelationId() ?? null;
}

function userAgent(req: Request): string | null {
  const agent = req.headers['user-agent'];
  if (Array.isArray(agent)) return agent.join(', ').slice(0, 200);
  return typeof agent === 'string' ? agent.slice(0, 200) : null;
}

function logCtdlRequested(args: AuditArgs): void {
  void db.from('audit_events').insert({
    event_type: 'ctdl.requested',
    event_category: 'VERIFICATION',
    target_type: 'credential',
    target_id: args.publicId,
    org_id: args.orgId ?? null,
    details: JSON.stringify({
      outcome: args.outcome,
      http_status: args.httpStatus,
      credential_status: args.credentialStatus ?? null,
      credential_type: args.credentialType ?? null,
      request_id: requestId(args.req),
      querying_ip: args.req.ip ?? null,
      querying_agent: userAgent(args.req),
      api_key_id: args.req.apiKey?.keyId ?? null,
    }),
  });
}

function normalizeAnchorRow(row: Record<string, unknown>): CtdlAnchor {
  const organization = row.organization as Record<string, unknown> | null | undefined;
  return {
    publicId: String(row.public_id ?? ''),
    orgId: typeof row.org_id === 'string' ? row.org_id : null,
    status: String(row.status ?? ''),
    credentialType: typeof row.credential_type === 'string' ? row.credential_type : null,
    subType: typeof row.sub_type === 'string' ? row.sub_type : null,
    label: typeof row.label === 'string' ? row.label : null,
    description: typeof row.description === 'string' ? row.description : null,
    metadata: row.metadata,
    createdAt: String(row.created_at ?? ''),
    chainTimestamp: typeof row.chain_timestamp === 'string' ? row.chain_timestamp : null,
    issuedAt: typeof row.issued_at === 'string' ? row.issued_at : null,
    expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    revocationReason: typeof row.revocation_reason === 'string' ? row.revocation_reason : null,
    issuer: organization ? {
      name: typeof organization.display_name === 'string' ? organization.display_name : null,
      publicId: typeof organization.public_id === 'string' ? organization.public_id : null,
      websiteUrl: typeof organization.website_url === 'string' ? organization.website_url : null,
      domain: typeof organization.domain === 'string' ? organization.domain : null,
    } : null,
  };
}

export const defaultCredentialsCtdlLookup: CredentialsCtdlLookup = {
  async lookupByPublicId(publicId: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('anchors')
      .select(
        'public_id, status, credential_type, sub_type, label, description, metadata, ' +
          'created_at, chain_timestamp, issued_at, expires_at, revoked_at, revocation_reason, org_id, ' +
          'organization:org_id(display_name, public_id, website_url, domain)',
      )
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;
    return normalizeAnchorRow(data as Record<string, unknown>);
  },
};

export function buildCredentialsCtdlRouter(lookup: CredentialsCtdlLookup = defaultCredentialsCtdlLookup): Router {
  const router = Router();

  router.get('/:publicId/ctdl', async (req, res) => {
    const publicId = req.params.publicId;
    if (!PUBLIC_ID_RE.test(publicId)) {
      logCtdlRequested({ req, publicId, outcome: 'invalid', httpStatus: 400 });
      res.status(400).json({ error: 'invalid_public_id' });
      return;
    }

    try {
      const anchor = await lookup.lookupByPublicId(publicId);
      if (!anchor) {
        logCtdlRequested({ req, publicId, outcome: 'not_found', httpStatus: 404 });
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const orgId = anchor.orgId ?? null;
      if (!isCtdlPublishableStatus(anchor.status)) {
        logCtdlRequested({
          req,
          publicId,
          outcome: 'not_publishable',
          httpStatus: 404,
          credentialStatus: anchor.status,
          credentialType: anchor.credentialType,
          orgId,
        });
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const body = buildCtdlJsonLd(anchor, { verifyUrl: buildVerifyUrl(publicId) });
      const revoked = anchor.status === 'REVOKED';
      const httpStatus = revoked ? 410 : 200;
      logCtdlRequested({
        req,
        publicId,
        outcome: revoked ? 'revoked' : 'published',
        httpStatus,
        credentialStatus: anchor.status,
        credentialType: anchor.credentialType,
        orgId,
      });
      res.status(httpStatus).type('application/ld+json').json(body);
    } catch (error) {
      logger.error({
        public_id: publicId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to build CTDL response');
      logCtdlRequested({ req, publicId, outcome: 'error', httpStatus: 500 });
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

export const credentialsCtdlRouter = buildCredentialsCtdlRouter();
