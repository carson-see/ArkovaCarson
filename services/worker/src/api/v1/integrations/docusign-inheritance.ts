/**
 * DocuSign connection inheritance — write path (SCRUM-3867, epic SCRUM-3863).
 *
 * A sub-organization may run its DocuSign envelopes on its PARENT's connection
 * instead of holding its own. Migration 0328 added the representation (an
 * `org_integrations` row with `inherited_from_org_id` set and no credentials of
 * its own), and `docusign-connection-resolver.ts`, the webhook and queue
 * reconciliation have all read it since. Nothing ever wrote one: production has
 * zero markers (pre-mortem F5). This module is the missing write path.
 *
 * WHY IT MATTERS COMMERCIALLY
 *   Inbound DocuSign connector setup requires the customer to hold their own
 *   DocuSign Organization on an Enhanced plan, with a claimed domain and SSO.
 *   A partner's client orgs generally do not have that and will not buy it to
 *   use us — so for those sub-orgs inheritance is not a convenience, it is the
 *   only path to connector-sourced documents.
 *
 * WHY THE PARENT AUTHORIZES, NOT THE CHILD
 *   A marker makes the sub-org's envelopes consume the PARENT's DocuSign
 *   credentials and quota. The party lending something is the parent; the child
 *   only receives a capability. So the caller must be an admin of the parent,
 *   the same shape as credit allocation. A child admin helping themselves to
 *   the parent's connection is exactly what the 403 below prevents.
 *
 * WHAT THIS DOES NOT NEED
 *   No migration. 0328 already ships the column, the credential-free CHECK and
 *   the parent-linkage trigger, and the resolver re-checks parent linkage at
 *   READ time — so a marker left stale by a later re-parent is already inert
 *   without a cleanup trigger here.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { db as defaultDb } from '../../../utils/db.js';
import { createLazyOAuthRouter } from './oauth-state.js';

const PROVIDER = 'docusign';

const InheritSchema = z.object({ org_id: z.string().uuid() });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export interface DocusignInheritanceDeps {
  db?: DbClient;
  now?: () => Date;
}

interface LiveIntegration {
  id: string;
  inherited_from_org_id: string | null;
}

function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

/** The org's single live (non-revoked) DocuSign row, if any. */
async function liveDocusign(
  db: DbClient,
  orgId: string,
): Promise<{ row: LiveIntegration | null; failed: boolean }> {
  const { data, error } = await db
    .from('org_integrations')
    .select('id, inherited_from_org_id')
    .eq('org_id', orgId)
    .eq('provider', PROVIDER)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    logger.error({ err: error.message, orgId }, 'docusign_inheritance_integration_lookup_failed');
    return { row: null, failed: true };
  }
  return { row: (data as LiveIntegration | null) ?? null, failed: false };
}

/**
 * Resolve the sub-org's parent and confirm the caller administers it.
 * Returns the parent id, or null after writing the response.
 */
async function requireParentAdminOfSubOrg(
  db: DbClient,
  req: Request,
  res: Response,
): Promise<{ userId: string; childOrgId: string; parentOrgId: string } | null> {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  const parsed = InheritSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return null;
  }
  const childOrgId = parsed.data.org_id;

  const { data: org, error: orgError } = await db
    .from('organizations')
    .select('parent_org_id')
    .eq('id', childOrgId)
    .maybeSingle();

  if (orgError) {
    // 503, not 409: a read failure must not be reported as "this org has no
    // parent", which reads as a settled fact about the org rather than an
    // outage.
    logger.error({ err: orgError.message, childOrgId }, 'docusign_inheritance_org_lookup_failed');
    res.status(503).json({ error: 'org_lookup_unavailable' });
    return null;
  }

  const parentOrgId = (org as { parent_org_id: string | null } | null)?.parent_org_id ?? null;
  if (!parentOrgId) {
    res.status(409).json({ error: 'not_a_sub_org' });
    return null;
  }

  const { data: membership, error: memberError } = await db
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', parentOrgId)
    .maybeSingle();

  if (memberError) {
    logger.error({ err: memberError.message, parentOrgId }, 'docusign_inheritance_member_lookup_failed');
    res.status(503).json({ error: 'membership_lookup_unavailable' });
    return null;
  }

  const role = (membership as { role?: string } | null)?.role;
  if (role !== 'owner' && role !== 'admin') {
    res.status(403).json({ error: 'Must be an admin of the parent organization' });
    return null;
  }

  return { userId, childOrgId, parentOrgId };
}

export function createDocusignInheritanceRouter(deps: DocusignInheritanceDeps = {}): Router {
  const db: DbClient = deps.db ?? defaultDb;
  const router = Router();

  router.post('/docusign/inherit', async (req: Request, res: Response) => {
    try {
      const ctx = await requireParentAdminOfSubOrg(db, req, res);
      if (!ctx) return;
      const { childOrgId, parentOrgId, userId } = ctx;

      const child = await liveDocusign(db, childOrgId);
      if (child.failed) {
        res.status(503).json({ error: 'integration_lookup_unavailable' });
        return;
      }
      if (child.row) {
        // Already delegating to this parent — nothing to do. Any other live row
        // is the sub-org's OWN connection, which the resolver prefers anyway;
        // replacing it here would silently drop a working connection.
        if (child.row.inherited_from_org_id === parentOrgId) {
          res.status(200).json({ inherited: true, from: parentOrgId, created: false });
          return;
        }
        res.status(409).json({ error: 'already_connected' });
        return;
      }

      const parent = await liveDocusign(db, parentOrgId);
      if (parent.failed) {
        res.status(503).json({ error: 'integration_lookup_unavailable' });
        return;
      }
      if (!parent.row) {
        res.status(409).json({ error: 'parent_not_connected' });
        return;
      }
      if (parent.row.inherited_from_org_id !== null) {
        // The resolver refuses to chain, so a marker pointing at a marker would
        // resolve to no credentials at job time — a connection that looks live
        // in the UI and silently does nothing.
        res.status(409).json({ error: 'parent_inherits' });
        return;
      }

      const { data, error } = await db
        .from('org_integrations')
        .insert({
          org_id: childOrgId,
          provider: PROVIDER,
          inherited_from_org_id: parentOrgId,
          // 0328's CHECK: a marker holds no credentials of its own.
          account_id: null,
          encrypted_tokens: null,
          token_secret_name: null,
        })
        .select('id')
        .single();

      if (error) {
        logger.error({ err: error.message, childOrgId, parentOrgId }, 'docusign_inheritance_insert_failed');
        res.status(503).json({ error: 'inheritance_write_unavailable' });
        return;
      }

      logger.info({ childOrgId, parentOrgId, userId }, 'docusign_inheritance_established');
      res.status(201).json({ inherited: true, from: parentOrgId, created: true, id: data?.id });
    } catch (error) {
      logger.error({ error }, 'Failed to establish DocuSign inheritance');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/docusign/inherit/stop', async (req: Request, res: Response) => {
    try {
      const ctx = await requireParentAdminOfSubOrg(db, req, res);
      if (!ctx) return;
      const { childOrgId, parentOrgId, userId } = ctx;

      const child = await liveDocusign(db, childOrgId);
      if (child.failed) {
        res.status(503).json({ error: 'integration_lookup_unavailable' });
        return;
      }
      // Only a marker is in scope. An org's OWN connection is disconnected via
      // /docusign/disconnect, which also deletes the refresh-token secret;
      // revoking it here would orphan that secret in Secret Manager.
      if (!child.row || child.row.inherited_from_org_id === null) {
        res.status(404).json({ error: 'no_inherited_connection' });
        return;
      }

      const now = (deps.now?.() ?? new Date()).toISOString();
      const { error } = await db
        .from('org_integrations')
        .update({ revoked_at: now })
        .eq('id', child.row.id)
        // Redundant with the id, and deliberately so: the update then cannot
        // touch another org's row even if the id were wrong, and the tenant
        // scope is visible to the isolation lint rather than implied by the
        // lookup two statements above.
        .eq('org_id', childOrgId);

      if (error) {
        logger.error({ err: error.message, childOrgId }, 'docusign_inheritance_revoke_failed');
        res.status(503).json({ error: 'inheritance_write_unavailable' });
        return;
      }

      logger.info({ childOrgId, parentOrgId, userId }, 'docusign_inheritance_stopped');
      res.status(200).json({ inherited: false });
    } catch (error) {
      logger.error({ error }, 'Failed to stop DocuSign inheritance');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/**
 * Lazy, like every other router in this folder: the eager form resolves
 * `utils/db.js` at import time, which loads and validates the whole worker
 * config. That makes the module un-importable in a unit test and turns any
 * config gap into a module-load crash rather than a request-time error.
 */
export const docusignInheritanceRouter: Router = createLazyOAuthRouter(
  () => createDocusignInheritanceRouter(),
);
