import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { requireScopeV2 } from './scopeGuard.js';
import { ProblemError } from './problem.js';
import { createV2ScopeRateLimit } from './rateLimit.js';
import { PUBLIC_ANCHOR_ID_RE, SHA256_HEX_RE, visibleAnchorScope } from './resourceIdentifiers.js';
import { publicAnchorTimestamp } from '../anchorTimestamp.js';

export const agentToolsRouter = Router();

interface V2QueryBuilder {
  select(columns: string): V2QueryBuilder;
  eq(column: string, value: string): V2QueryBuilder;
  in(column: string, values: string[]): V2QueryBuilder;
  is(column: string, value: null): V2QueryBuilder;
  or(filter: string): V2QueryBuilder;
  /**
   * Terminal for list reads: chainable AND awaitable, because PostgREST's
   * builder is both. Typed here rather than cast at the call site so a list
   * query cannot be awaited as if it returned a single row.
   */
  order(column: string, options: { ascending: boolean }): V2QueryBuilder
    & PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
  limit(count: number): V2QueryBuilder;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
}

const v2Db = db as unknown as {
  from(table: string): V2QueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
};

function pathParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function mapPublicAnchor(row: Record<string, unknown>, publicId: string): Record<string, unknown> {
  const status = (row.status as string | undefined) ?? 'UNKNOWN';
  return {
    public_id: publicId,
    verified: status === 'SECURED' || status === 'ACTIVE',
    status: status === 'SECURED' ? 'ACTIVE' : status,
    issuer_name: row.issuer_name ?? 'Unknown',
    credential_type: row.credential_type ?? 'UNKNOWN',
    issued_date: row.issued_date ?? null,
    expiry_date: row.expiry_date ?? null,
    anchor_timestamp: row.anchor_timestamp ?? null,
    network_receipt_id: row.network_receipt_id ?? null,
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
        .select('id, public_id, fingerprint, filename, status, created_at, chain_timestamp, chain_tx_id')
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
        // BUG-2026-09-08-001 (SCRUM-4517): chain-observed time, not row
        // creation. This contract declares the field nullable (see the
        // not-found branch above, which emits null), so an unmeasured moment
        // is null here rather than omitted.
        anchor_timestamp: publicAnchorTimestamp(status, data.chain_timestamp as string | null),
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
    if (!publicId || !PUBLIC_ANCHOR_ID_RE.test(publicId)) {
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
        .select('public_id, display_name, domain, website_url, verification_status, parent_org_id')
        .eq('id', req.apiKey.orgId)
        .maybeSingle();

      if (error) {
        logger.error({ error }, 'v2 list_orgs lookup failed');
        next(ProblemError.internalError('Failed to list organizations.'));
        return;
      }

      if (!data?.public_id) {
        res.json({ organizations: [] });
        return;
      }

      // SCRUM-3971 — hierarchy. Additive and public-id only: `parent_org_id`
      // is a banned response field (api/v1/response-schemas.ts), so the parent
      // is named by ITS public id and the raw uuid is resolved server-side.
      //
      // `parent_public_id` is OMITTED when the organization has no parent, not
      // emitted as null. That is this API's existing convention for "does not
      // apply" (see `jurisdiction` on the v1 verification response) and it
      // keeps "is a child" answerable by key presence alone.
      let parentPublicId: string | null = null;
      if (data.parent_org_id) {
        const { data: parent, error: parentError } = await v2Db.from('organizations')
          .select('public_id')
          .eq('id', data.parent_org_id as string)
          .maybeSingle();

        if (parentError) {
          logger.error({ error: parentError }, 'v2 list_orgs parent lookup failed');
          next(ProblemError.internalError('Failed to list organizations.'));
          return;
        }
        // A parent row that exists but cannot be named is not "no parent".
        // Omitting the field here would tell an agent this organization is
        // top-level when it is not, which changes what it may conclude about
        // every record it goes on to read.
        if (!parent?.public_id) {
          logger.error({ orgId: req.apiKey.orgId }, 'v2 list_orgs parent has no public id');
          next(ProblemError.internalError('Failed to list organizations.'));
          return;
        }
        parentPublicId = parent.public_id as string;
      }

      // One hop by construction: `check_sub_org_depth` allows a single level,
      // so `children` is the whole descendant set and no recursion is needed.
      const { data: children, error: childrenError } = await v2Db.from('organizations')
        .select('public_id, display_name, parent_approval_status')
        .eq('parent_org_id', req.apiKey.orgId)
        .order('created_at', { ascending: false });

      if (childrenError) {
        logger.error({ error: childrenError }, 'v2 list_orgs children lookup failed');
        next(ProblemError.internalError('Failed to list organizations.'));
        return;
      }

      // `?? []` would report "this organization has no affiliates" on a shape
      // fault, which an agent would act on as a fact.
      if (!Array.isArray(children)) {
        logger.error({ orgId: req.apiKey.orgId }, 'v2 list_orgs children lookup returned a non-array');
        next(ProblemError.internalError('Failed to list organizations.'));
        return;
      }
      const childRows = children as {
        public_id: string | null;
        display_name: string;
        parent_approval_status: string | null;
      }[];

      // Same rule as the parent above: a child we cannot name is not a child we
      // may silently drop from a list an agent will treat as complete.
      if (childRows.some((child) => !child.public_id)) {
        logger.error({ orgId: req.apiKey.orgId }, 'v2 list_orgs child has no public id');
        next(ProblemError.internalError('Failed to list organizations.'));
        return;
      }

      res.json({
        organizations: [{
          public_id: data.public_id,
          display_name: data.display_name,
          domain: data.domain,
          website_url: data.website_url,
          verification_status: data.verification_status,
          ...(parentPublicId ? { parent_public_id: parentPublicId } : {}),
          children: childRows.map((child) => ({
            public_id: child.public_id,
            display_name: child.display_name,
            parent_approval_status: child.parent_approval_status ?? null,
          })),
        }],
      });
    } catch (err) {
      next(err);
    }
  },
);
