/**
 * Google Drive connector service (SCRUM-1099 / SCRUM-1100)
 *
 * Coordinates OAuth, Secret Manager-backed token storage, 7-day Drive watch
 * channels, and rule-engine event shaping. No migration assumptions live here:
 * persistence is injected so production can use the approved store while unit
 * tests prove raw OAuth tokens never enter connection metadata.
 */
import { randomUUID } from 'node:crypto';

import { GOOGLE_DRIVE_VENDOR as CONNECTORS_GOOGLE_DRIVE_VENDOR } from '../../constants/connectors.js';
import {
  DRIVE_DEFAULT_SCOPES,
  buildAuthorizationUrl,
  createChangesWatch,
  exchangeCode,
  refreshAccessToken,
  revokeOAuthToken,
  stopDriveChannel,
  type DriveClientDeps,
} from '../oauth/drive.js';
import type { ConnectorCanonicalEventT } from './schemas.js';

// Re-export the canonical constant from constants/connectors.ts so consumers
// can keep importing it from this module without owning the literal here.
export const GOOGLE_DRIVE_VENDOR = CONNECTORS_GOOGLE_DRIVE_VENDOR;
export const GOOGLE_DRIVE_WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GOOGLE_DRIVE_WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface GoogleDriveStoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  token_type?: string;
}

export interface GoogleDriveTokenSecretStore {
  put(args: { name: string; value: GoogleDriveStoredTokens }): Promise<void>;
  get(args: { name: string }): Promise<GoogleDriveStoredTokens | null>;
  delete(args: { name: string }): Promise<void>;
}

export interface GoogleDriveConnectionRecord {
  orgId: string;
  integrationId: string;
  provider: typeof GOOGLE_DRIVE_VENDOR;
  tokenSecretName: string;
  scopes: string[];
  watchChannelId: string;
  watchResourceId: string;
  watchExpiresAt: string;
  connectedAt: string;
  connectedByUserId?: string;
}

export interface GoogleDriveConnectionStore {
  upsertGoogleDriveConnection(record: GoogleDriveConnectionRecord): Promise<void>;
  updateGoogleDriveWatch(args: {
    orgId: string;
    integrationId: string;
    watchChannelId: string;
    watchResourceId: string;
    watchExpiresAt: string;
    renewedAt: string;
  }): Promise<void>;
  markGoogleDriveDisconnected(args: {
    orgId: string;
    integrationId: string;
    disconnectedAt: string;
  }): Promise<void>;
}

export interface GoogleDriveConnectorDeps {
  tokenStore: GoogleDriveTokenSecretStore;
  connectionStore: GoogleDriveConnectionStore;
  drive?: DriveClientDeps;
  now?: () => Date;
  idFactory?: () => string;
}

export interface GoogleDriveRuleEventQueue {
  enqueue(event: GoogleDriveRuleEvent): Promise<{ eventId?: string }>;
}

export type GoogleDriveRuleEvent = ConnectorCanonicalEventT & {
  payload: {
    source: typeof GOOGLE_DRIVE_VENDOR;
    file_id: string;
    parent_ids: string[];
    drive_id?: string;
    change_resource_id?: string;
  };
};

export class GoogleDriveConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleDriveConnectorError';
  }
}

function nowIso(deps: Pick<GoogleDriveConnectorDeps, 'now'>): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function nextId(deps: Pick<GoogleDriveConnectorDeps, 'idFactory'>): string {
  return (deps.idFactory ?? randomUUID)();
}

// Reject anything that's not already a safe Secret Manager segment. The prior
// implementation silently rewrote unsafe chars to '_', which made
// `'abc xyz'` and `'abc_xyz'` collapse to the same secret name and share an
// OAuth credential — a cross-tenant token mix-up surface. Now we fail-closed
// at construction time.
const SAFE_SECRET_SEGMENT = /^[a-zA-Z0-9_-]{1,64}$/;

function secretSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new GoogleDriveConnectorError(`${label} is required`);
  if (!SAFE_SECRET_SEGMENT.test(trimmed)) {
    throw new GoogleDriveConnectorError(
      `${label} must match /^[A-Za-z0-9_-]{1,64}$/ (no whitespace, no path separators, no diacritics)`,
    );
  }
  return trimmed;
}

export function buildGoogleDriveTokenSecretName(args: {
  orgId: string;
  integrationId: string;
}): string {
  const org = secretSegment(args.orgId, 'orgId');
  const integration = secretSegment(args.integrationId, 'integrationId');
  return `arkova-google-drive-${org}-${integration}-oauth`;
}

export function buildGoogleDriveAuthorizationUrl(args: {
  redirectUri: string;
  state: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return buildAuthorizationUrl({
    redirectUri: args.redirectUri,
    state: args.state,
    scopes: DRIVE_DEFAULT_SCOPES,
    env: args.env,
  });
}

function toStoredTokens(args: {
  response: Awaited<ReturnType<typeof exchangeCode>> | Awaited<ReturnType<typeof refreshAccessToken>>;
  existingRefreshToken?: string;
  now: Date;
}): GoogleDriveStoredTokens {
  const refreshToken = args.response.refresh_token ?? args.existingRefreshToken;
  if (!refreshToken) {
    throw new GoogleDriveConnectorError(
      'Google OAuth response did not include a refresh_token. Re-run consent with prompt=consent.',
    );
  }
  return {
    access_token: args.response.access_token,
    refresh_token: refreshToken,
    expires_at: new Date(args.now.getTime() + args.response.expires_in * 1000).toISOString(),
    scope: args.response.scope ?? DRIVE_DEFAULT_SCOPES.join(' '),
    token_type: args.response.token_type,
  };
}

export async function completeGoogleDriveOAuth(args: {
  orgId: string;
  code: string;
  redirectUri: string;
  webhookAddress: string;
  webhookToken?: string;
  integrationId?: string;
  connectedByUserId?: string;
}, deps: GoogleDriveConnectorDeps): Promise<GoogleDriveConnectionRecord> {
  const issuedAt = deps.now?.() ?? new Date();
  const integrationId = args.integrationId ?? nextId(deps);
  const channelId = nextId(deps);
  const tokenSecretName = buildGoogleDriveTokenSecretName({
    orgId: args.orgId,
    integrationId,
  });

  const tokenResponse = await exchangeCode({
    code: args.code,
    redirectUri: args.redirectUri,
    deps: deps.drive,
  });
  const tokens = toStoredTokens({ response: tokenResponse, now: issuedAt });
  await deps.tokenStore.put({ name: tokenSecretName, value: tokens });

  try {
    const watch = await createChangesWatch({
      accessToken: tokens.access_token,
      channelId,
      address: args.webhookAddress,
      token: args.webhookToken,
      deps: deps.drive,
    });
    const record: GoogleDriveConnectionRecord = {
      orgId: args.orgId,
      integrationId,
      provider: GOOGLE_DRIVE_VENDOR,
      tokenSecretName,
      scopes: DRIVE_DEFAULT_SCOPES,
      watchChannelId: channelId,
      watchResourceId: watch.resourceId,
      watchExpiresAt: watch.expiration,
      connectedAt: issuedAt.toISOString(),
      connectedByUserId: args.connectedByUserId,
    };
    await deps.connectionStore.upsertGoogleDriveConnection(record);
    return record;
  } catch (err) {
    await deps.tokenStore.delete({ name: tokenSecretName }).catch(() => undefined);
    throw err;
  }
}

export function shouldRenewGoogleDriveWatch(args: {
  watchExpiresAt: string;
  now?: Date;
  renewalWindowMs?: number;
}): boolean {
  const now = args.now ?? new Date();
  const renewalWindowMs = args.renewalWindowMs ?? GOOGLE_DRIVE_WATCH_RENEWAL_WINDOW_MS;
  const expiresAt = new Date(args.watchExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - now.getTime() <= renewalWindowMs;
}

export async function renewGoogleDriveWatch(args: {
  orgId: string;
  integrationId: string;
  tokenSecretName: string;
  webhookAddress: string;
  webhookToken?: string;
  currentChannelId?: string;
  currentResourceId?: string;
}, deps: GoogleDriveConnectorDeps): Promise<{
  watchChannelId: string;
  watchResourceId: string;
  watchExpiresAt: string;
}> {
  const existing = await deps.tokenStore.get({ name: args.tokenSecretName });
  if (!existing) {
    throw new GoogleDriveConnectorError('Google Drive token secret is missing');
  }

  const refreshed = await refreshAccessToken({
    refreshToken: existing.refresh_token,
    deps: deps.drive,
  });
  const stored = toStoredTokens({
    response: refreshed,
    existingRefreshToken: existing.refresh_token,
    now: deps.now?.() ?? new Date(),
  });
  await deps.tokenStore.put({ name: args.tokenSecretName, value: stored });

  const nextChannelId = nextId(deps);
  const watch = await createChangesWatch({
    accessToken: stored.access_token,
    channelId: nextChannelId,
    address: args.webhookAddress,
    token: args.webhookToken,
    deps: deps.drive,
  });

  await deps.connectionStore.updateGoogleDriveWatch({
    orgId: args.orgId,
    integrationId: args.integrationId,
    watchChannelId: nextChannelId,
    watchResourceId: watch.resourceId,
    watchExpiresAt: watch.expiration,
    renewedAt: nowIso(deps),
  });

  if (args.currentChannelId && args.currentResourceId) {
    await stopDriveChannel({
      accessToken: stored.access_token,
      channelId: args.currentChannelId,
      resourceId: args.currentResourceId,
      deps: deps.drive,
    });
  }

  return {
    watchChannelId: nextChannelId,
    watchResourceId: watch.resourceId,
    watchExpiresAt: watch.expiration,
  };
}

export async function disconnectGoogleDriveConnection(args: {
  orgId: string;
  integrationId: string;
  tokenSecretName: string;
  watchChannelId?: string;
  watchResourceId?: string;
}, deps: GoogleDriveConnectorDeps): Promise<void> {
  const tokens = await deps.tokenStore.get({ name: args.tokenSecretName });

  if (tokens?.access_token && args.watchChannelId && args.watchResourceId) {
    await stopDriveChannel({
      accessToken: tokens.access_token,
      channelId: args.watchChannelId,
      resourceId: args.watchResourceId,
      deps: deps.drive,
    });
  }

  // Revoke the access_token (per-grant) rather than the refresh_token
  // (which Google revokes globally for the (user, client) pair). Revoking
  // the refresh_token would kill any *other* org this same end user has
  // connected — disconnecting Drive from org A would silently log them out
  // of org B. Falling back to refresh_token only when no access_token is
  // stored, since "no revoke at all" is worse than a broad revoke for the
  // single-org case.
  // See: https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
  const tokenToRevoke = tokens?.access_token ?? tokens?.refresh_token;
  if (tokenToRevoke) {
    await revokeOAuthToken({
      token: tokenToRevoke,
      deps: deps.drive,
    });
  }

  await deps.tokenStore.delete({ name: args.tokenSecretName });
  await deps.connectionStore.markGoogleDriveDisconnected({
    orgId: args.orgId,
    integrationId: args.integrationId,
    disconnectedAt: nowIso(deps),
  });
}

export function buildGoogleDriveRuleEvent(args: {
  orgId: string;
  fileId: string;
  filename?: string | null;
  parentIds?: string[];
  folderPath?: string | null;
  driveId?: string;
  changeResourceId?: string;
}): GoogleDriveRuleEvent {
  return {
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    org_id: args.orgId,
    vendor: GOOGLE_DRIVE_VENDOR,
    external_file_id: args.fileId,
    filename: args.filename ?? null,
    folder_path: args.folderPath ?? null,
    sender_email: null,
    subject: null,
    payload: {
      source: GOOGLE_DRIVE_VENDOR,
      file_id: args.fileId,
      parent_ids: args.parentIds ?? [],
      drive_id: args.driveId,
      change_resource_id: args.changeResourceId,
    },
  };
}

export async function enqueueGoogleDriveRuleEvent(args: Parameters<typeof buildGoogleDriveRuleEvent>[0], deps: {
  queue: GoogleDriveRuleEventQueue;
}): Promise<{ eventId?: string }> {
  return deps.queue.enqueue(buildGoogleDriveRuleEvent(args));
}
