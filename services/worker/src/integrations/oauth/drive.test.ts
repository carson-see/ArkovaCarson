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
  getStartPageToken,
  listChanges,
  listChildFolders,
  DriveConfigError,
  DriveApiError,
  DRIVE_FOLDER_LISTING_SCOPES,
  driveGrantExcessScopes,
} from './drive.js';
import { assertValidFieldsMask } from './__test-helpers__/fields-mask.js';

beforeEach(() => {
  // Intentionally blank — each test sets its own env.
});

// SCRUM-5287 (P1 security, fix-round item 5): prod holds a 32-scope grant
// (full drive, gmail.modify, contacts) for the one connected org, because
// the OAuth callback persisted whatever Google returned without checking it
// against DRIVE_DEFAULT_SCOPES. driveGrantExcessScopes is the shared
// detector both the callback (refuse+don't persist) and connector-health.ts
// (flag an EXISTING over-scoped row) build on.
describe('driveGrantExcessScopes', () => {
  it('returns [] for an EXACT match of the full requested scope set', () => {
    expect(driveGrantExcessScopes(DRIVE_DEFAULT_SCOPES.join(' '))).toEqual([]);
  });

  it('returns [] for a SUBSET of the requested scopes (Google not echoing every granted scope back)', () => {
    expect(driveGrantExcessScopes('https://www.googleapis.com/auth/drive.file')).toEqual([]);
  });

  it('normalizes the `email`/`profile` short aliases Google sometimes echoes instead of the full URI', () => {
    expect(driveGrantExcessScopes('https://www.googleapis.com/auth/drive.file email')).toEqual([]);
  });

  it('allows `openid` without counting it as excess (harmless OIDC bookkeeping, no data access)', () => {
    expect(driveGrantExcessScopes('https://www.googleapis.com/auth/drive.file openid')).toEqual([]);
  });

  it('flags a SUPERSET grant — the exact prod incident shape', () => {
    const excess = driveGrantExcessScopes(
      'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/drive.file',
    );
    expect(excess).toEqual([
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/contacts',
    ]);
  });

  it('returns [] for null/undefined/empty (nothing to flag when Google returned no scope string)', () => {
    expect(driveGrantExcessScopes(null)).toEqual([]);
    expect(driveGrantExcessScopes(undefined)).toEqual([]);
    expect(driveGrantExcessScopes('')).toEqual([]);
  });
});

describe('assertValidFieldsMask (shared test helper)', () => {
  it('accepts a well-formed nested mask', () => {
    expect(() =>
      assertValidFieldsMask(
        'newStartPageToken,nextPageToken,changes(fileId,removed,changeType,time,file(id,name,parents,driveId,modifiedTime,headRevisionId,trashed,mimeType,lastModifyingUser(emailAddress,displayName)))',
      ),
    ).not.toThrow();
  });

  it('accepts a simple flat mask', () => {
    expect(() => assertValidFieldsMask('id,name,parents,driveId')).not.toThrow();
  });

  it('rejects an empty mask', () => {
    expect(() => assertValidFieldsMask('')).toThrow(/empty/);
  });

  it('rejects a whitespace-joined mask (e.g. an accidental `.join(\' \')`)', () => {
    expect(() => assertValidFieldsMask('newStartPageToken nextPageToken')).toThrow(/whitespace/);
  });

  it('rejects unbalanced (unclosed) parentheses', () => {
    expect(() => assertValidFieldsMask('changes(fileId,file(id,name)')).toThrow(/unmatched|unclosed/);
  });

  it('rejects unbalanced (stray close) parentheses', () => {
    expect(() => assertValidFieldsMask('changes(fileId))')).toThrow(/unmatched/);
  });

  it('rejects a trailing comma', () => {
    expect(() => assertValidFieldsMask('id,name,')).toThrow(/trailing comma/);
  });

  it('rejects a stray/empty comma', () => {
    expect(() => assertValidFieldsMask('id,,name')).toThrow(/stray comma/);
  });

  it('rejects an unrecognized character', () => {
    expect(() => assertValidFieldsMask('id;name')).toThrow(/unrecognized character/);
  });

  it('does NOT alone catch a no-separator join fusion (documented limitation — exact-string assertions cover this)', () => {
    // 'newStartPageToken' + 'nextPageToken' joined with '' (no separator at
    // all) fuses into a single identifier-looking token — structurally
    // indistinguishable from one long legitimate field name.
    expect(() => assertValidFieldsMask('newStartPageTokennextPageToken,changes(fileId)')).not.toThrow();
  });
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
    // the connector itself; drive.metadata.readonly added for the Connectors
    // page folder picker (SPEC-CONNECTORS §2.1 "Option A" — reviewed as part
    // of that CTO spec session, 2026-09-13: metadata-only, cannot read file
    // bytes, is the minimum scope that makes a pre-existing folder listable);
    // userinfo.email because the callback's fetchGoogleIdentity
    // (oauth2/v3/userinfo) needs it for the stable account_id (`sub`) —
    // without it userinfo 401s and account_id degrades to a constant,
    // breaking the org_integrations upsert key. Any addition here widens what
    // a leaked refresh token can reach — treat as a security review.
    expect(DRIVE_DEFAULT_SCOPES).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.activity.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
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

// SPEC-CONNECTORS §2.2 / §6 — Connectors page folder picker.
describe('listChildFolders', () => {
  it('composes the files.list query and maps the response (My Drive only)', async () => {
    let capturedUrl = '';
    let capturedAuth: string | null = null;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(
        JSON.stringify({
          files: [
            { id: 'f1', name: 'Signed contracts', driveId: undefined },
            { id: 'f2', name: 'Onboarding', driveId: undefined },
          ],
          nextPageToken: 'tok-2',
        }),
        { status: 200 },
      );
    };

    const res = await listChildFolders({
      accessToken: 'access-tok',
      parent: 'root',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(res).toEqual({
      folders: [
        { id: 'f1', name: 'Signed contracts', driveId: null },
        { id: 'f2', name: 'Onboarding', driveId: null },
      ],
      nextPageToken: 'tok-2',
    });
    expect(capturedAuth).toBe('Bearer access-tok');

    const url = new URL(capturedUrl);
    expect(url.pathname).toBe('/drive/v3/files');
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(url.searchParams.get('orderBy')).toBe('name');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    // D2: My Drive only — this is the literal guard against a shared-drive
    // folder being selectable and silently never firing (PM-2).
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('false');
    expect(url.searchParams.get('fields')).toBe('nextPageToken,files(id,name,driveId)');
    expect(url.searchParams.get('q')).toBe(
      "'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
    );
  });

  it('omits nextPageToken from the result when Drive omits it', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ files: [] }), { status: 200 });
    const res = await listChildFolders({
      accessToken: 'at',
      parent: 'root',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(res).toEqual({ folders: [] });
    expect('nextPageToken' in res).toBe(false);
  });

  it('passes pageToken through as the outbound pageToken param', async () => {
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    };
    await listChildFolders({
      accessToken: 'at',
      parent: 'folder-1',
      pageToken: 'page-2',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(new URL(capturedUrl).searchParams.get('pageToken')).toBe('page-2');
  });

  it('escapes a quote and a backslash in parent so they cannot terminate the q clause (test 19)', async () => {
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    };
    // Attempted injection: close the quoted literal, then splice extra query
    // syntax after it. Also carries a literal backslash.
    const maliciousParent = "abc' or trashed=false or '1'='1" + '\\';
    await listChildFolders({
      accessToken: 'at',
      parent: maliciousParent,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const q = new URL(capturedUrl).searchParams.get('q')!;

    // Exact expected literal: backslashes doubled, quotes backslash-escaped —
    // Drive's own query-language escaping (not URL-encoding, which
    // URLSearchParams already handled underneath this).
    const expectedEscapedParent = maliciousParent.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    expect(q).toBe(
      `'${expectedEscapedParent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );
    // And the clause the caller's raw input could have spliced in
    // (` or trashed=false or `) never appears OUTSIDE the quoted literal —
    // it is still inside the escaped run between the opening and the ONE
    // real closing quote this function added.
    expect(q.endsWith("' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false")).toBe(true);
  });

  it('throws a bounded DriveApiError (with Retry-After when present) on a non-ok response', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Retry-After': '17' },
      });
    const err = await listChildFolders({
      accessToken: 'at',
      parent: 'root',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect((err as DriveApiError).status).toBe(429);
    expect((err as DriveApiError).retryAfter).toBe('17');
    // Bounded/scrubbed detail from the (metadata-only, safe) Google error
    // JSON — never a raw or unbounded body.
    expect((err as DriveApiError).detail).toContain('rate limited');
  });

  it('DRIVE_FOLDER_LISTING_SCOPES excludes drive.file (the #1 risk in SPEC-CONNECTORS §2.1)', () => {
    expect(DRIVE_FOLDER_LISTING_SCOPES).toEqual([
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ]);
    expect(DRIVE_FOLDER_LISTING_SCOPES).not.toContain('https://www.googleapis.com/auth/drive.file');
  });

  it('getFileMetadata: fields mask is exactly id,name,parents,driveId (exact-string, in addition to structural)', async () => {
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ id: 'f', name: 'n', parents: [] }), { status: 200 });
    };
    await getFileMetadata({
      fileId: 'f',
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const fields = new URL(capturedUrl).searchParams.get('fields')!;
    expect(fields).toBe('id,name,parents,driveId');
    expect(() => assertValidFieldsMask(fields)).not.toThrow();
  });

  it('getSharedDriveName: fields mask is exactly name (exact-string, in addition to structural)', async () => {
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ name: 'Legal Team Drive' }), { status: 200 });
    };
    await getSharedDriveName({
      driveId: 'd',
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const fields = new URL(capturedUrl).searchParams.get('fields')!;
    expect(fields).toBe('name');
    expect(() => assertValidFieldsMask(fields)).not.toThrow();
  });

  it('listChildFolders: fields mask passes the structural validator (regression guard for the same defect class)', async () => {
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    };
    await listChildFolders({
      accessToken: 'at',
      parent: 'root',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const fields = new URL(capturedUrl).searchParams.get('fields')!;
    expect(fields).toBe('nextPageToken,files(id,name,driveId)');
    expect(() => assertValidFieldsMask(fields)).not.toThrow();
  });
});

// SCRUM-2903 / SCRUM-3661 / SCRUM-5094 / SCRUM-2330: `listChanges` built its
// `fields` mask via an EMPTY-STRING array `.join('')`, fusing
// `newStartPageToken` + `nextPageToken` + the start of `changes(...)` into
// one invalid run with no separating commas. Google answered every call
// with HTTP 400 `Invalid field selection newStartPageTokennextP...` —
// confirmed in prod logs, 150x/day since the 2026-05-04 commit that
// introduced it. No prior test ever asserted the URL/fields shape here.
describe('listChanges (SCRUM-2903 fields-mask regression)', () => {
  async function captureListChangesUrl(): Promise<string> {
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ changes: [], newStartPageToken: '99' }),
        { status: 200 },
      );
    };
    await listChanges({
      accessToken: 'access-tok',
      pageToken: 'token-1',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    return capturedUrl;
  }

  it('sends a `fields` mask that is a single well-formed, comma-separated mask (structural)', async () => {
    const url = await captureListChangesUrl();
    const fields = new URL(url).searchParams.get('fields');
    expect(fields).not.toBeNull();
    // This is the assertion that actually catches the incident: the old
    // code produced 'newStartPageTokennextPageTokenchanges(...)' — no
    // comma between the first two top-level entries, and no comma between
    // 'nextPageToken' and 'changes('. Both fuse into ONE identifier-looking
    // run that a pure structural tokenizer cannot distinguish from a single
    // (very long) legitimate field name — see the doc comment on
    // assertValidFieldsMask for why the exact-string assertion below is the
    // real regression guard and this call is defense-in-depth only.
    expect(() => assertValidFieldsMask(fields!)).not.toThrow();
  });

  it('sends the EXACT expected `fields` mask string (the real regression guard)', async () => {
    const url = await captureListChangesUrl();
    const fields = new URL(url).searchParams.get('fields');
    expect(fields).toBe(
      'newStartPageToken,nextPageToken,changes(fileId,removed,changeType,time,file(id,name,parents,driveId,modifiedTime,headRevisionId,trashed,mimeType,lastModifyingUser(emailAddress,displayName)))',
    );
  });

  it('sends the correct top-level query params (pageToken, includeRemoved, supportsAllDrives, includeItemsFromAllDrives)', async () => {
    const url = await captureListChangesUrl();
    const params = new URL(url).searchParams;
    expect(new URL(url).pathname).toBe('/drive/v3/changes');
    expect(params.get('pageToken')).toBe('token-1');
    expect(params.get('includeRemoved')).toBe('true');
    expect(params.get('supportsAllDrives')).toBe('true');
    expect(params.get('includeItemsFromAllDrives')).toBe('true');
  });

  it('sends the caller access token as a Bearer header', async () => {
    let capturedAuth: string | null = null;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(JSON.stringify({ changes: [] }), { status: 200 });
    };
    await listChanges({
      accessToken: 'access-tok-2',
      pageToken: 'tok',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(capturedAuth).toBe('Bearer access-tok-2');
  });

  it('parses a real (documented-shape) changes.list response, including a change missing `parents` (shared-drive item)', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          changes: [
            {
              fileId: 'file-1',
              removed: false,
              changeType: 'file',
              time: '2026-09-20T12:00:00.000Z',
              file: {
                id: 'file-1',
                name: 'Shared item.pdf',
                // No `parents` — this happens on some shared-drive items per
                // Google's documented response shape.
                driveId: 'shared-drive-1',
                modifiedTime: '2026-09-20T12:00:00.000Z',
                headRevisionId: 'rev-1',
                trashed: false,
                mimeType: 'application/pdf',
              },
            },
          ],
          nextPageToken: 'page-2',
        }),
        { status: 200 },
      );
    const res = await listChanges({
      accessToken: 'at',
      pageToken: 'tok',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0].file?.parents).toBeUndefined();
    expect(res.nextPageToken).toBe('page-2');
  });

  it('throws a bounded DriveApiError on a non-ok response (e.g. the real HTTP 400 this fields mask caused)', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid field selection newStartPageTokennextP..." } }),
        { status: 400 },
      );
    const err = await listChanges({
      accessToken: 'at',
      pageToken: 'tok',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect((err as DriveApiError).status).toBe(400);
    expect((err as DriveApiError).detail).toContain('Invalid field selection');
  });
});

describe('createChangesWatch (exact URL/param assertions)', () => {
  it('calls changes/startPageToken then changes/watch with the exact expected query params (My Drive, no driveId)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ startPageToken: 'start-1' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ resourceId: 'res-1', expiration: String(Date.now() + 1000) }),
        { status: 200 },
      );
    };
    await createChangesWatch({
      accessToken: 'at',
      channelId: 'chan-1',
      address: 'https://arkova.ai/webhooks/drive',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    const startUrl = new URL(calls[0].url);
    expect(startUrl.pathname).toBe('/drive/v3/changes/startPageToken');
    expect(startUrl.search).toBe('');

    const watchUrl = new URL(calls[1].url);
    expect(watchUrl.pathname).toBe('/drive/v3/changes/watch');
    expect(watchUrl.searchParams.get('pageToken')).toBe('start-1');
    expect(watchUrl.searchParams.has('driveId')).toBe(false);
    expect(watchUrl.searchParams.has('supportsAllDrives')).toBe(false);
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      id: 'chan-1',
      type: 'web_hook',
      address: 'https://arkova.ai/webhooks/drive',
      token: undefined,
    });
  });

  it('scopes both calls to a shared drive when driveId is provided', async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = async (url: string) => {
      calls.push({ url });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ startPageToken: 'start-2' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ resourceId: 'res-2', expiration: String(Date.now() + 1000) }),
        { status: 200 },
      );
    };
    await createChangesWatch({
      accessToken: 'at',
      channelId: 'chan-2',
      address: 'https://arkova.ai/webhooks/drive',
      driveId: 'shared-drive-9',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const startUrl = new URL(calls[0].url);
    expect(startUrl.searchParams.get('driveId')).toBe('shared-drive-9');
    expect(startUrl.searchParams.get('supportsAllDrives')).toBe('true');
    const watchUrl = new URL(calls[1].url);
    expect(watchUrl.searchParams.get('driveId')).toBe('shared-drive-9');
    expect(watchUrl.searchParams.get('supportsAllDrives')).toBe('true');
    expect(watchUrl.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });
});

describe('getStartPageToken (extracted for 410/404 cursor recovery reuse)', () => {
  it('GETs changes/startPageToken and returns the token (My Drive, no driveId)', async () => {
    let capturedUrl = '';
    let capturedAuth: string | null = null;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(JSON.stringify({ startPageToken: 'fresh-token' }), { status: 200 });
    };
    const token = await getStartPageToken({
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(token).toBe('fresh-token');
    expect(capturedAuth).toBe('Bearer at');
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe('/drive/v3/changes/startPageToken');
    expect(url.search).toBe('');
  });

  it('scopes to a shared drive when driveId is provided', async () => {
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ startPageToken: 'fresh-token-2' }), { status: 200 });
    };
    await getStartPageToken({
      accessToken: 'at',
      driveId: 'shared-drive-1',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('driveId')).toBe('shared-drive-1');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
  });

  it('throws a bounded DriveApiError on failure', async () => {
    const fetchImpl = async () => new Response('{}', { status: 500 });
    const err = await getStartPageToken({
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect((err as DriveApiError).status).toBe(500);
  });
});
