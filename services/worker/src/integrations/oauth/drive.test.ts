/**
 * Google Drive OAuth + watch tests (SCRUM-1168)
 *
 * Pure unit tests with a stubbed fetch impl. Covers authorization URL shape,
 * token exchange, refresh flow, and changes.watch / files.get wrappers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  createChangesWatch,
  getFileMetadata,
  getSharedDriveName,
  DriveConfigError,
  DriveApiError,
} from './drive.js';

beforeEach(() => {
  // Intentionally blank — each test sets its own env.
});

describe('buildAuthorizationUrl', () => {
  it('throws when client ID is missing', () => {
    expect(() =>
      buildAuthorizationUrl({
        redirectUri: 'https://arkova.ai/cb',
        state: 'x',
        env: {},
      }),
    ).toThrow(DriveConfigError);
  });

  it('includes scopes, state, redirect, and offline access_type', () => {
    const url = buildAuthorizationUrl({
      redirectUri: 'https://arkova.ai/cb',
      state: 'nonce-xyz',
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      },
    });
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url).toContain('client_id=client-id');
    expect(url).toContain('state=nonce-xyz');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('scope=');
    expect(url).toContain('prompt=consent');
  });
});

describe('exchangeCode', () => {
  it('throws DriveConfigError when client is missing', async () => {
    await expect(
      exchangeCode({
        code: 'c',
        redirectUri: 'r',
        deps: { env: {} },
      }),
    ).rejects.toBeInstanceOf(DriveConfigError);
  });

  it('returns parsed tokens on success', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          access_token: 'at',
          expires_in: 3600,
          refresh_token: 'rt',
          scope: 'drive.file',
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    const res = await exchangeCode({
      code: 'code',
      redirectUri: 'https://arkova.ai/cb',
      deps: {
        env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    expect(res.access_token).toBe('at');
    expect(res.refresh_token).toBe('rt');
  });

  it('throws DriveApiError on non-2xx', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    const err = await exchangeCode({
      code: 'bad',
      redirectUri: 'r',
      deps: {
        env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect((err as DriveApiError).status).toBe(400);
  });
});

describe('refreshAccessToken', () => {
  it('parses the expected fields', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ access_token: 'new-at', expires_in: 1800, token_type: 'Bearer' }),
        { status: 200 },
      );
    const res = await refreshAccessToken({
      refreshToken: 'rt',
      deps: {
        env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    expect(res.access_token).toBe('new-at');
    expect(res.expires_in).toBe(1800);
  });
});

describe('createChangesWatch', () => {
  it('returns { resourceId, expiration } on success', async () => {
    let call = 0;
    const fetchImpl = async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ startPageToken: '42' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          resourceId: 'res-123',
          expiration: String(Date.now() + 6 * 24 * 60 * 60 * 1000),
        }),
        { status: 200 },
      );
    };
    const res = await createChangesWatch({
      accessToken: 'at',
      channelId: 'ch',
      address: 'https://arkova.ai/webhooks/drive',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(res.resourceId).toBe('res-123');
    expect(res.expiration).toMatch(/T/);
  });

  it('throws DriveApiError when startPageToken fails', async () => {
    const fetchImpl = async () => new Response('{}', { status: 500 });
    const err = await createChangesWatch({
      accessToken: 'at',
      channelId: 'ch',
      address: 'https://arkova.ai/webhooks/drive',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
  });
});

describe('getFileMetadata', () => {
  it('returns id/name/parents on success', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ id: 'f', name: 'doc.pdf', parents: ['p1', 'p2'], driveId: 'd' }),
        { status: 200 },
      );
    const res = await getFileMetadata({
      fileId: 'f',
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(res).toEqual({ id: 'f', name: 'doc.pdf', parents: ['p1', 'p2'], driveId: 'd' });
  });

  it('throws DriveApiError when fields missing', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
    const err = await getFileMetadata({
      fileId: 'f',
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
  });
});

describe('getSharedDriveName', () => {
  it('returns name on success', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ name: 'Legal Team Drive' }), { status: 200 });
    const res = await getSharedDriveName({
      driveId: 'd',
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(res).toBe('Legal Team Drive');
  });

  it('falls back to driveId on error', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500 });
    const res = await getSharedDriveName({
      driveId: 'drive-abc',
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(res).toBe('drive-abc');
  });
});
