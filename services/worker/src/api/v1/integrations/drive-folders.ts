/**
 * Google Drive folder picker (Connectors page — SPEC-CONNECTORS §2.2).
 *
 * GET /api/v1/integrations/google_drive/folders?org_id=<uuid>&parent=<folderId|root>
 *
 * Mounted on the SAME path scope as `driveOAuthRouter` in `index.ts`, so it
 * inherits identical middleware: `pathScopedKillSwitch('/google_drive',
 * 'ENABLE_DRIVE_OAUTH')`, `rateLimiters.api` (60 req/min/IP), and
 * `integrationsAuthGate` → `requireAuthMw` → `extractAuthUserId`, which
 * accepts ONLY a Supabase JWT via `verifyAuthToken`. An Arkova API key in the
 * `Authorization: Bearer` header fails token verification and gets 401 —
 * there is no API-key path to this router.
 *
 * Authz is org-admin, resolved through the canonical owner-inclusive
 * resolver (`api/_org-auth.ts`) — NOT a hand-rolled `org_members` lookup
 * (`drive-oauth.ts` documents why that check is wrong: an owner linked only
 * via `profiles.org_id` has no `org_members` row).
 *
 * FAIL CLOSED (Builder Contract clause 1): every denial branch below is a
 * distinct, typed, counted response. NONE of them returns `{folders: []}` —
 * an empty array is indistinguishable from "you have no folders", which is
 * exactly the failure PM-1 (SPEC-CONNECTORS §7) warns against for a
 * `drive.file`-only grant.
 *
 * §1.6 / §1.6A: this is a metadata path. No document bytes are read, stored,
 * logged, or sent to Sentry. Logging is bounded to
 * `{orgId, integrationId, parentId, resultCount, status, durationMs}` —
 * NEVER a folder name, an assembled path, `driveId` owner data, the access
 * token, or the raw Drive response body.
 */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { db as defaultDb } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { isCallerOrgAdminResult } from '../../_org-auth.js';
import {
  DriveApiError,
  DRIVE_FOLDER_LISTING_SCOPES,
  listChildFolders,
  type DriveClientDeps,
} from '../../../integrations/oauth/drive.js';
import {
  loadDriveAccessToken,
  DriveRunnerError,
  type DriveIntegrationRow,
} from '../../../integrations/connectors/drive-changes-runner.js';
import { createDefaultKmsClient, type KmsClient } from '../../../integrations/oauth/crypto.js';
import { rateLimit } from '../../../utils/rateLimit.js';

// Not `parent: z.string()...` alone — `root` is a Drive API literal, not a
// real folder id, so it gets its own branch rather than min(1) swallowing it
// by accident.
const QuerySchema = z.object({
  org_id: z.string().uuid(),
  parent: z.union([z.literal('root'), z.string().trim().min(1).max(500)]).default('root'),
  page_token: z.string().trim().max(5000).optional(),
});

function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

/**
 * 30 req/min PER ORG, layered on top of the shared `rateLimiters.api` 60
 * req/min-per-IP bucket the mount in `index.ts` already applies. The IP
 * bucket alone does not bound a single org behind a corporate NAT, and every
 * request here is an outbound Google API call (PM-8, SPEC-CONNECTORS §7).
 */
export const driveFoldersOrgRateLimit = rateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  scope: 'drive-folders-org',
  keyGenerator: (req) => `org:${typeof req.query.org_id === 'string' ? req.query.org_id : 'unknown'}`,
});

export interface DriveFoldersRouterDeps {
  // Loosely-typed on purpose (mirrors DriveChangesRunnerDeps['db']): a real
  // SupabaseClient satisfies this structurally, and a test double doesn't
  // need every generic overload of `.from()` to match.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: { from: (table: string) => any; rpc: (...args: unknown[]) => any };
  kms?: KmsClient;
  drive?: DriveClientDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * `org_integrations.scope` is Google's space-separated grant string. Exact
 * membership only — `drive.file`'s scope URL is NOT a substring match away
 * from `drive` (`.../auth/drive.file`.includes('.../auth/drive')` would be
 * `true` and defeat the whole check), so this splits on whitespace and
 * compares full scope URLs.
 */
function hasFolderListingScope(scope: string | null | undefined): boolean {
  if (!scope) return false;
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return DRIVE_FOLDER_LISTING_SCOPES.some((s) => granted.has(s));
}

function mapDriveApiError(err: DriveApiError): { status: number; code: string; message: string; retryAfter?: string } {
  if (err.status === 401) {
    return { status: 409, code: 'reconnect_required', message: 'Your Google Drive connection expired. Reconnect to choose folders.' };
  }
  if (err.status === 403) {
    return { status: 403, code: 'folder_forbidden', message: 'You do not have permission to open that folder in Google Drive.' };
  }
  if (err.status === 404) {
    return { status: 404, code: 'folder_not_found', message: 'That folder no longer exists in Google Drive.' };
  }
  if (err.status === 429 || err.status >= 500) {
    return {
      status: 502,
      code: 'drive_unavailable',
      message: 'Google Drive is not responding right now. Please try again in a moment.',
      retryAfter: err.retryAfter ?? '30',
    };
  }
  return { status: 500, code: 'internal', message: 'Internal server error' };
}

export function createDriveFoldersRouter(deps: DriveFoldersRouterDeps = {}): Router {
  const router = Router();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SupabaseClient's overloaded `.from()` doesn't structurally satisfy the loose `{from,rpc}` shape shared with drive-changes-runner.ts; every call site below is a narrow, typed query.
  const db = deps.db ?? (defaultDb as any);

  router.get('/google_drive/folders', driveFoldersOrgRateLimit, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
      return;
    }

    // D2 — shared drives are OUT of v1. Refuse explicitly rather than
    // silently ignoring the param (SPEC-CONNECTORS §2.2, test 18).
    if (req.query.drive !== undefined) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'Shared drives are not supported yet' } });
      return;
    }

    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'invalid_request', message: 'Invalid query', details: parsed.error.flatten() },
      });
      return;
    }
    const { org_id: orgId, parent, page_token: pageToken } = parsed.data;

    const admin = await isCallerOrgAdminResult(userId, orgId);
    if (admin.error) {
      res.status(500).json({ error: { code: 'internal', message: 'Failed to verify authorization' } });
      return;
    }
    if (!admin.value) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Only organization admins can browse Drive folders' } });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: integration, error: integrationError } = await (db as any)
      .from('org_integrations')
      .select('id, org_id, scope, encrypted_tokens, token_kms_key_id')
      .eq('org_id', orgId)
      .eq('provider', 'google_drive')
      .is('revoked_at', null)
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (integrationError) {
      logger.error({ error: integrationError, orgId }, 'drive-folders: org_integrations lookup failed');
      res.status(500).json({ error: { code: 'internal', message: 'Failed to load Drive connection' } });
      return;
    }
    if (!integration) {
      res.status(404).json({ error: { code: 'not_connected', message: 'Connect Google Drive before choosing folders.' } });
      return;
    }

    // D3 — fail closed on a scope that cannot list folders. Checked BEFORE
    // any Drive call (test 16: Drive must never be called on this branch).
    if (!hasFolderListingScope(integration.scope as string | null | undefined)) {
      logger.warn({ orgId, integrationId: integration.id }, 'drive-folders: insufficient scope');
      res.status(409).json({
        error: { code: 'insufficient_drive_scope', message: 'Arkova needs permission to see your folder names. Reconnect Google Drive to continue.' },
      });
      return;
    }

    let accessToken: string;
    try {
      const kms = deps.kms ?? (await createDefaultKmsClient());
      const tokenResult = await loadDriveAccessToken(
        integration as DriveIntegrationRow,
        { db, kms, drive: deps.drive, env: deps.env, now: deps.now },
      );
      accessToken = tokenResult.accessToken;
    } catch (err) {
      if (err instanceof DriveRunnerError || err instanceof DriveApiError) {
        logger.warn({ error: err.message, orgId, integrationId: integration.id }, 'drive-folders: token load failed');
        res.status(409).json({
          error: { code: 'reconnect_required', message: 'Your Google Drive connection expired. Reconnect to choose folders.' },
        });
        return;
      }
      logger.error({ error: err, orgId }, 'drive-folders: unexpected token load error');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
      return;
    }

    try {
      const result = await listChildFolders({ accessToken, parent, pageToken, deps: deps.drive });
      const durationMs = Date.now() - startedAt;
      logger.info(
        {
          orgId,
          integrationId: integration.id,
          parentId: parent,
          resultCount: result.folders.length,
          status: 200,
          durationMs,
        },
        'drive-folders: list ok',
      );
      const body: {
        folders: Array<{ id: string; name: string; hasChildren: null; driveId: string | null }>;
        nextPageToken?: string;
      } = {
        folders: result.folders.map((f) => ({ id: f.id, name: f.name, hasChildren: null, driveId: f.driveId })),
      };
      if (result.nextPageToken) body.nextPageToken = result.nextPageToken;
      res.json(body);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (err instanceof DriveApiError) {
        const mapped = mapDriveApiError(err);
        logger.warn(
          { orgId, integrationId: integration.id, parentId: parent, status: mapped.status, durationMs },
          'drive-folders: Drive API error',
        );
        if (mapped.retryAfter) res.setHeader('Retry-After', mapped.retryAfter);
        res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
        return;
      }
      logger.error({ error: err, orgId, durationMs }, 'drive-folders: unexpected list error');
      res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
    }
  });

  return router;
}

/** Default-configured router — mounted directly in `index.ts`. */
export const driveFoldersRouter: Router = createDriveFoldersRouter();
