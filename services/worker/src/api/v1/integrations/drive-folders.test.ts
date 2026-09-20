/**
 * GET /api/v1/integrations/google_drive/folders — SPEC-CONNECTORS §2.2, §6
 * (tests 12-21, adapted to this repo's supertest + express conventions —
 * see drive-oauth.test.ts for the pattern this mirrors).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { KmsClient } from '../../../integrations/oauth/crypto.js';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333';
const FIXTURE_FOLDER_NAME = 'Q3 Board Minutes';
const FIXTURE_ACCESS_TOKEN = 'ya29.fixture-access-token-do-not-log';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The module-level `defaultDb` import in drive-folders.ts pulls in
// utils/db.js -> config.ts, whose Zod boot validation requires a full env
// fixture. Every test here injects its own `deps.db`, so the real client is
// never used — stub it out the same way drive-oauth.test.ts does.
vi.mock('../../../utils/db.js', () => ({ db: {} }));

vi.mock('../../_org-auth.js', () => ({
  isCallerOrgAdminResult: vi.fn(async () => ({ value: true, error: false })),
}));

import { logger as mockLogger } from '../../../utils/logger.js';
import { isCallerOrgAdminResult } from '../../_org-auth.js';
import { createDriveFoldersRouter } from './drive-folders.js';
import { setRateLimitStore } from '../../../utils/rateLimit.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdmin = isCallerOrgAdminResult as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLoggerAny = mockLogger as any;

function fakeKms(): KmsClient {
  const tokens = {
    access_token: FIXTURE_ACCESS_TOKEN,
    refresh_token: 'refresh-token-do-not-log',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  return {
    async decrypt() {
      return Buffer.from(JSON.stringify(tokens));
    },
    async encrypt({ plaintext }: { plaintext: Buffer }) {
      return plaintext;
    },
  };
}

function integrationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTEGRATION_ID,
    org_id: TEST_ORG_ID,
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
    encrypted_tokens: '\\xaabbcc',
    token_kms_key_id: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
    ...overrides,
  };
}

function dbWithIntegration(row: Record<string, unknown> | null, error: unknown = null) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const handler: Record<string, unknown> = {
    select: (...a: unknown[]) => { calls.push({ method: 'select', args: a }); return handler; },
    eq: (...a: unknown[]) => { calls.push({ method: 'eq', args: a }); return handler; },
    is: (...a: unknown[]) => { calls.push({ method: 'is', args: a }); return handler; },
    order: () => handler,
    limit: () => handler,
    maybeSingle: async () => ({ data: row, error }),
  };
  return { from: () => handler, rpc: vi.fn(), calls };
}

function fetchOk(body: unknown, opts: { status?: number; headers?: Record<string, string> } = {}) {
  const status = opts.status ?? 200;
  const fn = vi.fn(async (_url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k: string) => (opts.headers ?? {})[k.toLowerCase()] ?? null },
  }));
  return fn as unknown as typeof fetch;
}

function buildApp(opts: {
  db?: ReturnType<typeof dbWithIntegration>;
  fetchImpl?: typeof fetch;
  attachUser?: boolean;
} = {}) {
  const app = express();
  app.use((req, _res, next) => {
    if (opts.attachUser !== false) {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
    }
    next();
  });
  const db = opts.db ?? dbWithIntegration(integrationRow());
  app.use(
    '/api/v1/integrations',
    createDriveFoldersRouter({
      db,
      kms: fakeKms(),
      drive: { fetchImpl: opts.fetchImpl ?? fetchOk({ files: [], nextPageToken: undefined }) },
    }),
  );
  return { app, db };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdmin.mockResolvedValue({ value: true, error: false });
  setRateLimitStore(new Map());
});

describe('GET /google_drive/folders', () => {
  it('happy path: composes the Drive query and returns the mapped shape (test 12)', async () => {
    const fetchImpl = fetchOk({
      files: [{ id: 'f1', name: FIXTURE_FOLDER_NAME, driveId: undefined }],
      nextPageToken: 'np1',
    });
    const { app } = buildApp({ fetchImpl });

    const res = await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID, parent: 'root' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      folders: [{ id: 'f1', name: FIXTURE_FOLDER_NAME, hasChildren: null, driveId: null }],
      nextPageToken: 'np1',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calledUrl = (fetchImpl as any).mock.calls[0][0] as string;
    const url = new URL(calledUrl);
    expect(url.pathname).toBe('/drive/v3/files');
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(url.searchParams.get('orderBy')).toBe('name');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('false');
    expect(url.searchParams.get('fields')).toBe('nextPageToken,files(id,name,driveId)');
    expect(url.searchParams.get('q')).toBe(
      "'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
    );
  });

  it('gives 401 with no Authorization header at all (test 14)', async () => {
    const fetchImpl = fetchOk({ files: [] });
    const { app } = buildApp({ fetchImpl, attachUser: false });

    const res = await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('403s a valid caller who is not an org admin of the requested org, no Drive call (test 15)', async () => {
    mockAdmin.mockResolvedValue({ value: false, error: false });
    const fetchImpl = fetchOk({ files: [] });
    const { app } = buildApp({ fetchImpl });

    const res = await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('404s when the org has no connected Drive integration', async () => {
    const db = dbWithIntegration(null);
    const fetchImpl = fetchOk({ files: [] });
    const { app } = buildApp({ db, fetchImpl });

    const res = await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_connected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('409s insufficient_drive_scope for a drive.file-only grant, never returns [] , never calls Drive (test 16)', async () => {
    const db = dbWithIntegration(integrationRow({ scope: 'https://www.googleapis.com/auth/drive.file' }));
    const fetchImpl = fetchOk({ files: [] });
    const { app } = buildApp({ db, fetchImpl });

    const res = await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('insufficient_drive_scope');
    expect(res.body).not.toEqual({ folders: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drive=<id> gives 400 invalid_request and never calls Drive (test 18)', async () => {
    const fetchImpl = fetchOk({ files: [] });
    const { app } = buildApp({ fetchImpl });

    const res = await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID, drive: 'shared-drive-1' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('escapes a quote/backslash in parent into the q literal rather than breaking it (test 19)', async () => {
    const fetchImpl = fetchOk({ files: [] });
    const { app } = buildApp({ fetchImpl });

    const maliciousParent = `x' or 'a'='a`;
    const res = await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID, parent: maliciousParent });

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calledUrl = (fetchImpl as any).mock.calls[0][0] as string;
    const q = new URL(calledUrl).searchParams.get('q')!;
    // The escaped literal keeps the ENTIRE parent inside one quoted clause —
    // it never contains an unescaped `' in parents` sequence from OUR input.
    expect(q).toBe(
      "'x\\' or \\'a\\'=\\'a' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
    );
  });

  it('never logs the fixture folder name or the access token (test 20)', async () => {
    const fetchImpl = fetchOk({ files: [{ id: 'f1', name: FIXTURE_FOLDER_NAME }] });
    const { app } = buildApp({ fetchImpl });

    await request(app)
      .get('/api/v1/integrations/google_drive/folders')
      .query({ org_id: TEST_ORG_ID });

    const allCalls = [
      ...mockLoggerAny.info.mock.calls,
      ...mockLoggerAny.warn.mock.calls,
      ...mockLoggerAny.error.mock.calls,
      ...mockLoggerAny.debug.mock.calls,
    ];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain(FIXTURE_FOLDER_NAME);
    expect(serialized).not.toContain(FIXTURE_ACCESS_TOKEN);
  });

  describe('Drive API error mapping (test 17)', () => {
    it.each([
      [401, 'reconnect_required', 409],
      [403, 'folder_forbidden', 403],
      [404, 'folder_not_found', 404],
      [429, 'drive_unavailable', 502],
      [500, 'drive_unavailable', 502],
    ])('Drive %i maps to %s / HTTP %i', async (driveStatus, code, httpStatus) => {
      const headers: Record<string, string> = driveStatus === 429 ? { 'retry-after': '12' } : {};
      const fetchImpl = fetchOk({ error: { message: 'drive error' } }, { status: driveStatus as number, headers });
      const { app } = buildApp({ fetchImpl });

      const res = await request(app)
        .get('/api/v1/integrations/google_drive/folders')
        .query({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(httpStatus);
      expect(res.body.error.code).toBe(code);
      if (driveStatus === 429) {
        expect(res.headers['retry-after']).toBe('12');
      }
    });
  });

  it('rate-limits the 31st request in a window for the same org with 429 + Retry-After (test 21)', async () => {
    const fetchImpl = fetchOk({ files: [] });
    const { app } = buildApp({ fetchImpl });

    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      // Intentionally serial: each call must land in the same rate-limit window.
      const res = await request(app)
        .get('/api/v1/integrations/google_drive/folders')
        .query({ org_id: TEST_ORG_ID });
      statuses.push(res.status);
      if (i === 30) {
        expect(res.status).toBe(429);
        expect(res.headers['retry-after']).toBeDefined();
      }
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });
});
