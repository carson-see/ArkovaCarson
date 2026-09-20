/**
 * F-D0-5 (memory/feedback_bounded_body_reads.md): every Google Drive API body
 * read must settle by a deadline.
 *
 * `drive.ts` guarded nothing on the body side — all nine external reads were
 * `await res.json().catch(() => null)`. A Google endpoint that sends headers
 * and then stalls the body parks that await with no timer: undici's default
 * `bodyTimeout` fires only on TOTAL silence, so a trickling socket holds it
 * open indefinitely. `refreshAccessToken` and `listChanges` are both called
 * from inside `withRunLease`-held cron runs (drive-changes-runner,
 * drive-subscription-renewal), which is exactly the shape that disabled
 * SUBMITTED→SECURED promotion for every tenant for 35+ minutes on 2026-08-12.
 *
 * Found while reviewing PR #2912, which added a tenth matching read in the
 * same file and tripped the `bounded-body-reads` ratchet (labelled
 * `unbounded-body-read-reviewed` rather than blocking a sealed train PR).
 *
 * This suite drives the REAL `readJsonBounded` with its deadline shrunk from
 * 10s to ~25ms, against fetch doubles whose bodies never settle, and pins that
 * every entry point ABANDONS the parked read instead of hanging.
 */
import { describe, it, expect, vi } from 'vitest';

// Shrink the module's body-read deadline so a parked read resolves in tens of
// milliseconds. The primitive keeps its REAL implementation — only the deadline
// argument is overridden. The true production value is pinned by the
// DRIVE_BODY_READ_TIMEOUT_MS ratchet below, and the primitive's own timing
// behavior by utils/body-read-timeout.test.ts.
vi.mock('../../utils/body-read-timeout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/body-read-timeout.js')>();
  return {
    ...actual,
    readJsonBounded: (response: never, url: string, _timeoutMs: number) =>
      actual.readJsonBounded(response, url, 25),
    readTextBounded: (response: never, url: string, _timeoutMs: number) =>
      actual.readTextBounded(response, url, 25),
  };
});

const {
  DRIVE_BODY_READ_TIMEOUT_MS,
  DriveApiError,
  createChangesWatch,
  exchangeCode,
  getFileMetadata,
  getSharedDriveName,
  listChanges,
  listChildFolders,
  refreshAccessToken,
  revokeOAuthToken,
  stopDriveChannel,
} = await import('./drive.js');

const OAUTH_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
};

/** A response whose headers arrived but whose body never settles. */
function parkedBody(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => new Promise<never>(() => {}),
    text: () => new Promise<never>(() => {}),
    headers: new Headers(),
  } as unknown as Response;
}

/** A response that settles normally. */
function jsonBody(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  } as unknown as Response;
}

/**
 * Every assertion below must complete well inside vitest's default timeout —
 * a regression to an unbounded read shows up as a TIMED-OUT test, which is the
 * failure mode this suite is designed to surface.
 */
describe('drive.ts body reads are bounded (F-D0-5)', () => {
  it('pins the production body-read deadline', () => {
    // Ratchet: the suite above shrinks this to 25ms, so the shipped value can
    // only be verified here. 10s matches the Adobe Sign connector.
    expect(DRIVE_BODY_READ_TIMEOUT_MS).toBe(10_000);
  });

  it('exchangeCode abandons a parked token-exchange body', async () => {
    const fetchImpl = vi.fn(async () => parkedBody());
    await expect(
      exchangeCode({
        code: 'auth-code',
        redirectUri: 'https://arkova.ai/cb',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch, env: OAUTH_ENV },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('refreshAccessToken abandons a parked refresh body', async () => {
    const fetchImpl = vi.fn(async () => parkedBody());
    await expect(
      refreshAccessToken({
        refreshToken: 'refresh-token',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch, env: OAUTH_ENV },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('createChangesWatch abandons a parked startPageToken body', async () => {
    const fetchImpl = vi.fn(async () => parkedBody());
    await expect(
      createChangesWatch({
        accessToken: 'token',
        channelId: 'chan-1',
        address: 'https://arkova.ai/webhooks/drive',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('createChangesWatch abandons a parked changes.watch body', async () => {
    const fetchImpl = vi
      .fn<(url: string) => Promise<Response>>()
      .mockImplementationOnce(async () => jsonBody({ startPageToken: 'tok-1' }))
      .mockImplementationOnce(async () => parkedBody());
    await expect(
      createChangesWatch({
        accessToken: 'token',
        channelId: 'chan-1',
        address: 'https://arkova.ai/webhooks/drive',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('stopDriveChannel abandons a parked error body', async () => {
    const fetchImpl = vi.fn(async () => parkedBody(500));
    await expect(
      stopDriveChannel({
        accessToken: 'token',
        channelId: 'chan-1',
        resourceId: 'res-1',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('revokeOAuthToken abandons a parked error body', async () => {
    const fetchImpl = vi.fn(async () => parkedBody(500));
    await expect(
      revokeOAuthToken({
        token: 'token',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('getFileMetadata abandons a parked files.get body', async () => {
    const fetchImpl = vi.fn(async () => parkedBody());
    await expect(
      getFileMetadata({
        fileId: 'file-1',
        accessToken: 'token',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('listChanges abandons a parked changes.list body', async () => {
    const fetchImpl = vi.fn(async () => parkedBody());
    await expect(
      listChanges({
        accessToken: 'token',
        pageToken: 'tok-1',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  });

  it('listChildFolders abandons a parked folder-page body', async () => {
    await expect(listChildFolders({
      accessToken: 'local-only', parent: 'root',
      deps: { fetchImpl: (async () => parkedBody()) as typeof fetch },
    })).rejects.toMatchObject({ name: 'DriveApiError', status: 408 });
  }, 1000);

  it('getSharedDriveName falls back to the drive id on a parked body rather than hanging', async () => {
    // Documented contract: "Falls back to the ID on failure." A body-read
    // timeout is a failure — it must not become a throw, and it must not park.
    const fetchImpl = vi.fn(async () => parkedBody());
    await expect(
      getSharedDriveName({
        driveId: 'drive-1',
        accessToken: 'token',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).resolves.toBe('drive-1');
  });

  it('a malformed (non-JSON) body still degrades to null, not a 408', async () => {
    // The previous `.catch(() => null)` swallowed parse errors. That behavior
    // is preserved — only the PARKED case becomes a distinct 408.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
      headers: new Headers(),
    }) as unknown as Response);
    await expect(
      getFileMetadata({
        fileId: 'file-1',
        accessToken: 'token',
        deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError', status: 502 });
  });

  it('never leaks a raw body onto the timeout error (§1.6A)', async () => {
    const fetchImpl = vi.fn(async () => parkedBody(500));
    const error = await revokeOAuthToken({
      token: 'token',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriveApiError);
    // The bounded reader embeds its `url` argument verbatim in the message it
    // throws. drive.ts must pass a stable operation LABEL, never a Drive URL
    // carrying a fileId / driveId / access token.
    expect((error as Error).message).not.toContain('googleapis.com');
    expect((error as InstanceType<typeof DriveApiError>).detail).toBeUndefined();
  });
});
