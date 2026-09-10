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
 * DATABASE BOUNDARIES
 *   0328 supplies the credential-free marker and parent-linkage check; 0446
 *   makes stop authorization and revocation atomic. The resolver also checks
 *   parent linkage at read time, so stale markers cannot lend credentials.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { db as defaultDb } from '../../../utils/db.js';
import { createLazyOAuthRouter } from './oauth-state.js';
import { isCallerOrgAdminResult } from '../../_org-auth.js';

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

/** Owned accounts may be multiple; the credential-free marker is unique. */
async function liveDocusign(
  db: DbClient,
  orgId: string,
  kind: 'owned' | 'inherited',
): Promise<{ row: LiveIntegration | null; failed: boolean }> {
  const query = db
    .from('org_integrations')
    .select('id, inherited_from_org_id')
    .eq('org_id', orgId)
    .eq('provider', PROVIDER)
    .is('revoked_at', null);
  // This is an existence check, not account selection. Credential resolution
  // chooses the actual owned account later; any owned row takes precedence.
  const scoped = kind === 'owned'
    ? query.is('inherited_from_org_id', null).limit(1)
    : query.not('inherited_from_org_id', 'is', null);
  const { data, error } = await scoped.maybeSingle();
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

  const admin = await isCallerOrgAdminResult(userId, parentOrgId, undefined, db);

  if (admin.error) {
    logger.error({ parentOrgId }, 'docusign_inheritance_member_lookup_failed');
    res.status(503).json({ error: 'membership_lookup_unavailable' });
    return null;
  }

  if (!admin.value) {
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

      const ownedChild = await liveDocusign(db, childOrgId, 'owned');
      if (ownedChild.failed) {
        res.status(503).json({ error: 'integration_lookup_unavailable' });
        return;
      }
      if (ownedChild.row) {
        res.status(409).json({ error: 'already_connected' });
        return;
      }
      const child = await liveDocusign(db, childOrgId, 'inherited');
      if (child.failed) {
        res.status(503).json({ error: 'integration_lookup_unavailable' });
        return;
      }
      if (child.row) {
        // Only the matching marker is idempotent; a stale marker needs an
        // explicit stop before a new inheritance relationship is established.
        if (child.row.inherited_from_org_id === parentOrgId) {
          res.status(200).json({ inherited: true, from: parentOrgId, created: false });
          return;
        }
        res.status(409).json({ error: 'already_connected' });
        return;
      }

      const parent = await liveDocusign(db, parentOrgId, 'owned');
      if (parent.failed) {
        res.status(503).json({ error: 'integration_lookup_unavailable' });
        return;
      }
      if (!parent.row) {
        const parentMarker = await liveDocusign(db, parentOrgId, 'inherited');
        if (parentMarker.failed) {
          res.status(503).json({ error: 'integration_lookup_unavailable' });
          return;
        }
        // The resolver never chains inheritance through another marker.
        res.status(409).json({ error: parentMarker.row ? 'parent_inherits' : 'parent_not_connected' });
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

      const child = await liveDocusign(db, childOrgId, 'inherited');
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

      // The relationship can change after the reads above. Lock and recheck it
      // with parent administration and marker revocation in one transaction.
      const { data, error } = await db.rpc('stop_suborg_docusign_inheritance', {
        p_parent_org_id: parentOrgId,
        p_child_org_id: childOrgId,
        p_integration_id: child.row.id,
        p_inherited_from_org_id: child.row.inherited_from_org_id,
        p_caller_user_id: userId,
        p_revoked_at: (deps.now?.() ?? new Date()).toISOString(),
      });

      if (error) {
        logger.error({ err: error.message, childOrgId }, 'docusign_inheritance_revoke_failed');
        res.status(503).json({ error: 'inheritance_write_unavailable' });
        return;
      }
      if (data?.error === 'parent_admin_required' || data?.error === 'authentication_required') {
        res.status(403).json({ error: data.error });
        return;
      }
      if (data?.error === 'child_parent_changed' || data?.error === 'inherited_connection_changed') {
        res.status(409).json({ error: data.error });
        return;
      }
      if (data?.success !== true) {
        logger.error({ childOrgId }, 'docusign_inheritance_unexpected_stop_result');
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
