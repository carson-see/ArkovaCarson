/**
 * Google Drive OAuth + watch tests (SCRUM-1168)
 *
 * Pure unit tests with a stubbed fetch impl. Covers authorization URL shape,
 * token exchange, refresh flow, and changes.watch / files.get wrappers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DRIVE_DEFAULT_SCOPES,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  createChangesWatch,
  stopDriveChannel,
  revokeOAuthToken,
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
    expect(new URL(url).searchParams.get('scope')).toBe(DRIVE_DEFAULT_SCOPES.join(' '));
    // Scope-minimality ratchet (FULLSOAK 2026-08, shared-resource register #9):
    // this is the COMPLETE allowlist. drive.file + drive.activity.readonly for
    // the connector itself; userinfo.email because the callback's
    // fetchGoogleIdentity (oauth2/v3/userinfo) needs it for the stable
    // account_id (`sub`) — without it userinfo 401s and account_id degrades to
    // a constant, breaking the org_integrations upsert key. Any addition here
    // widens what a leaked refresh token can reach — treat as a security review.
    expect(DRIVE_DEFAULT_SCOPES).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.activity.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
  });

  it('never sends include_granted_scopes — a Drive connect must not inherit scopes previously granted to the OAuth client', () => {
    // FULLSOAK 2026-08 finding: with `include_granted_scopes=true` on the
    // shared OAuth client, one Drive connect minted a grant carrying 33 scopes
    // (full drive, gmail.modify, calendar, contacts, classroom.*, chat.*) —
    // every scope that client was ever granted by the Google account. The
    // parameter must be ABSENT (Google defaults it to false), so a compromised
    // refresh token is scoped to the minimal Drive set and nothing else.
    const url = buildAuthorizationUrl({
      redirectUri: 'https://arkova.ai/cb',
      state: 'nonce-xyz',
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      },
    });
    const params = new URL(url).searchParams;
    expect(params.has('include_granted_scopes')).toBe(false);
    expect(params.get('include_granted_scopes')).not.toBe('true');
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

describe('stopDriveChannel', () => {
  it('POSTs channel id + resource id to Drive channels.stop', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    };
    await stopDriveChannel({
      accessToken: 'at',
      channelId: 'channel-1',
      resourceId: 'resource-1',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(calls[0].url).toContain('/drive/v3/channels/stop');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      id: 'channel-1',
      resourceId: 'resource-1',
    });
  });

  it('throws DriveApiError on non-2xx', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: 'gone' } }), { status: 410 });
    await expect(
      stopDriveChannel({
        accessToken: 'at',
        channelId: 'channel-1',
        resourceId: 'resource-1',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toBeInstanceOf(DriveApiError);
  });
});

describe('revokeOAuthToken', () => {
  it('revokes a token without logging or returning it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    };
    await revokeOAuthToken({
      token: 'refresh-token',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('token=refresh-token');
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
