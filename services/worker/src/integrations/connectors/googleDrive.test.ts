import { describe, expect, it } from 'vitest';

import {
  GOOGLE_DRIVE_WATCH_RENEWAL_WINDOW_MS,
  buildGoogleDriveAuthorizationUrl,
  buildGoogleDriveRuleEvent,
  buildGoogleDriveTokenSecretName,
  completeGoogleDriveOAuth,
  disconnectGoogleDriveConnection,
  enqueueGoogleDriveRuleEvent,
  renewGoogleDriveWatch,
  shouldRenewGoogleDriveWatch,
  type GoogleDriveConnectionRecord,
  type GoogleDriveConnectorDeps,
  type GoogleDriveStoredTokens,
} from './googleDrive.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-04-24T12:00:00.000Z');
const WATCH_EXPIRATION_MS = NOW.getTime() + 6 * 24 * 60 * 60 * 1000;

function makeStores(): {
  deps: Omit<GoogleDriveConnectorDeps, 'drive'>;
  secrets: Map<string, GoogleDriveStoredTokens>;
  upserts: GoogleDriveConnectionRecord[];
  watchUpdates: unknown[];
  disconnects: unknown[];
} {
  const secrets = new Map<string, GoogleDriveStoredTokens>();
  const upserts: GoogleDriveConnectionRecord[] = [];
  const watchUpdates: unknown[] = [];
  const disconnects: unknown[] = [];
  return {
    secrets,
    upserts,
    watchUpdates,
    disconnects,
    deps: {
      now: () => NOW,
      idFactory: () => 'channel-next',
      tokenStore: {
        async put({ name, value }) {
          secrets.set(name, value);
        },
        async get({ name }) {
          return secrets.get(name) ?? null;
        },
        async delete({ name }) {
          secrets.delete(name);
        },
      },
      connectionStore: {
        async upsertGoogleDriveConnection(record) {
          upserts.push(record);
        },
        async updateGoogleDriveWatch(args) {
          watchUpdates.push(args);
        },
        async markGoogleDriveDisconnected(args) {
          disconnects.push(args);
        },
      },
    },
  };
}

function makeDriveFetch(calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const rawUrl = String(url);
    calls.push({ url: rawUrl, init });
    if (rawUrl === 'https://oauth2.googleapis.com/token') {
      const body = String(init?.body ?? '');
      if (body.includes('grant_type=authorization_code')) {
        return new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.activity.readonly',
            token_type: 'Bearer',
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: 'renewed-access-token',
          expires_in: 1800,
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    }
    if (rawUrl.endsWith('/changes/startPageToken')) {
      return new Response(JSON.stringify({ startPageToken: 'page-token' }), { status: 200 });
    }
    if (rawUrl.includes('/changes/watch?')) {
      return new Response(
        JSON.stringify({
          resourceId: 'watch-resource',
          expiration: String(WATCH_EXPIRATION_MS),
        }),
        { status: 200 },
      );
    }
    if (rawUrl.endsWith('/channels/stop')) {
      return new Response('{}', { status: 200 });
    }
    if (rawUrl === 'https://oauth2.googleapis.com/revoke') {
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return fetchImpl as unknown as typeof fetch;
}

describe('Google Drive connector OAuth', () => {
  it('uses only drive.file + drive.activity.readonly scopes in the consent URL', () => {
    const url = buildGoogleDriveAuthorizationUrl({
      redirectUri: 'https://arkova.ai/api/v1/integrations/google-drive/callback',
      state: 'state-1',
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
      },
    });
    expect(new URL(url).searchParams.get('scope')).toBe(
      [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.activity.readonly',
      ].join(' '),
    );
  });

  it('stores OAuth tokens only in the token secret store, not connection metadata', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const stores = makeStores();
    const record = await completeGoogleDriveOAuth(
      {
        orgId: ORG,
        integrationId: 'drive-primary',
        code: 'oauth-code',
        redirectUri: 'https://arkova.ai/callback',
        webhookAddress: 'https://worker.arkova.ai/webhooks/google-drive',
        connectedByUserId: 'user-1',
      },
      {
        ...stores.deps,
        drive: {
          fetchImpl: makeDriveFetch(calls),
          env: {
            GOOGLE_OAUTH_CLIENT_ID: 'client-id',
            GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
          },
        },
      },
    );

    const secretName = buildGoogleDriveTokenSecretName({
      orgId: ORG,
      integrationId: 'drive-primary',
    });
    expect(stores.secrets.get(secretName)?.refresh_token).toBe('refresh-token');
    expect(stores.upserts[0]).toEqual(record);
    const serializedRecord = JSON.stringify(record);
    expect(serializedRecord).not.toContain('access-token');
    expect(serializedRecord).not.toContain('refresh-token');
    expect(record.tokenSecretName).toBe(secretName);
    expect(record.watchChannelId).toBe('channel-next');
    expect(record.watchResourceId).toBe('watch-resource');
  });
});

describe('Google Drive watch lifecycle', () => {
  it('knows when a 7-day watch is inside the renewal window', () => {
    expect(
      shouldRenewGoogleDriveWatch({
        now: NOW,
        watchExpiresAt: new Date(NOW.getTime() + GOOGLE_DRIVE_WATCH_RENEWAL_WINDOW_MS - 1).toISOString(),
      }),
    ).toBe(true);
    expect(
      shouldRenewGoogleDriveWatch({
        now: NOW,
        watchExpiresAt: new Date(NOW.getTime() + GOOGLE_DRIVE_WATCH_RENEWAL_WINDOW_MS + 1).toISOString(),
      }),
    ).toBe(false);
  });

  it('refreshes tokens, creates a new watch, and stops the prior channel', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const stores = makeStores();
    const secretName = buildGoogleDriveTokenSecretName({
      orgId: ORG,
      integrationId: 'drive-primary',
    });
    stores.secrets.set(secretName, {
      access_token: 'old-access-token',
      refresh_token: 'refresh-token',
      expires_at: NOW.toISOString(),
      scope: 'https://www.googleapis.com/auth/drive.file',
      token_type: 'Bearer',
    });

    const watch = await renewGoogleDriveWatch(
      {
        orgId: ORG,
        integrationId: 'drive-primary',
        tokenSecretName: secretName,
        webhookAddress: 'https://worker.arkova.ai/webhooks/google-drive',
        currentChannelId: 'channel-old',
        currentResourceId: 'resource-old',
      },
      {
        ...stores.deps,
        drive: {
          fetchImpl: makeDriveFetch(calls),
          env: {
            GOOGLE_OAUTH_CLIENT_ID: 'client-id',
            GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
          },
        },
      },
    );

    expect(stores.secrets.get(secretName)?.access_token).toBe('renewed-access-token');
    expect(watch.watchResourceId).toBe('watch-resource');
    expect(stores.watchUpdates).toEqual([
      {
        orgId: ORG,
        integrationId: 'drive-primary',
        watchChannelId: 'channel-next',
        watchResourceId: 'watch-resource',
        watchExpiresAt: new Date(WATCH_EXPIRATION_MS).toISOString(),
        renewedAt: NOW.toISOString(),
      },
    ]);
    expect(calls.some((call) => call.url.endsWith('/channels/stop'))).toBe(true);
  });

  it('disconnects by stopping the channel, revoking the token, deleting the secret, and marking metadata', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const stores = makeStores();
    const secretName = buildGoogleDriveTokenSecretName({
      orgId: ORG,
      integrationId: 'drive-primary',
    });
    stores.secrets.set(secretName, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: NOW.toISOString(),
      scope: 'https://www.googleapis.com/auth/drive.file',
      token_type: 'Bearer',
    });

    await disconnectGoogleDriveConnection(
      {
        orgId: ORG,
        integrationId: 'drive-primary',
        tokenSecretName: secretName,
        watchChannelId: 'channel-1',
        watchResourceId: 'resource-1',
      },
      { ...stores.deps, drive: { fetchImpl: makeDriveFetch(calls) } },
    );

    expect(stores.secrets.has(secretName)).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/channels/stop'))).toBe(true);
    expect(calls.some((call) => call.url === 'https://oauth2.googleapis.com/revoke')).toBe(true);
    expect(stores.disconnects).toEqual([
      { orgId: ORG, integrationId: 'drive-primary', disconnectedAt: NOW.toISOString() },
    ]);
  });
});

describe('Google Drive rule events', () => {
  it('carries Drive parent IDs in payload for folder-bound rules', () => {
    const event = buildGoogleDriveRuleEvent({
      orgId: ORG,
      fileId: 'file-1',
      filename: 'contract.pdf',
      parentIds: ['folder-a', 'folder-b'],
      folderPath: '/Legal/MSAs/contract.pdf',
      changeResourceId: 'resource-1',
    });
    expect(event).toMatchObject({
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      vendor: 'google_drive',
      external_file_id: 'file-1',
      folder_path: '/Legal/MSAs/contract.pdf',
      payload: {
        parent_ids: ['folder-a', 'folder-b'],
        source: 'google_drive',
      },
    });
  });

  it('enqueues the canonical rule event', async () => {
    const queued: unknown[] = [];
    const result = await enqueueGoogleDriveRuleEvent(
      { orgId: ORG, fileId: 'file-1', parentIds: ['folder-a'] },
      {
        queue: {
          async enqueue(event) {
            queued.push(event);
            return { eventId: 'event-1' };
          },
        },
      },
    );
    expect(result).toEqual({ eventId: 'event-1' });
    expect(queued).toHaveLength(1);
  });
});
