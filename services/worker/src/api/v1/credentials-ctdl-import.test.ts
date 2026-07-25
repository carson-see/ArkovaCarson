/**
 * SCRUM-2913 — CTDL import CONSUMER route tests.
 *
 * `GET /api/v1/credentials/ctdl/import?ctid=ce-<uuid>` is the missing caller that
 * makes the importer demo-able: give a CE CTID, it fetches the PUBLIC CE registry
 * `/graph/<ctid>` envelope and runs it through `parseCtdlEnvelope`, returning the
 * bounded parsed credential record(s).
 *
 * SSRF model under test: the client supplies ONLY a `ctid`, strictly validated
 * against `^ce-<uuid>$`. The fetch host is NEVER request-derived — it is built
 * from the server-side registry base. The outbound fetch is mocked here (the
 * committed real `__fixtures__/ce-real-graph-*.json` bytes are fed back as the
 * registry response) — no real network is ever touched.
 *
 * §1.6A discipline under test: the raw registry bytes must NEVER reach the
 * logger, Sentry, or an Error message. A logger spy asserts the body never
 * appears in any log call.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import { buildCredentialsCtdlImportRouter } from './credentials-ctdl-import.js';
import type { SafeFetchDeps, SafeFetchResponse } from '../../lib/safe-fetch.js';

const { insertAudit, loggerWarn, loggerError, loggerInfo } = vi.hoisted(() => ({
  insertAudit: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'audit_events') return { insert: insertAudit };
      return { select: vi.fn() };
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: vi.fn() },
}));

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'ctdl', '__fixtures__');
const CRED_CTID = 'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b';
const GRAPH_RAW = fs.readFileSync(
  path.join(FIXTURES_DIR, `ce-real-graph-${CRED_CTID}.json`),
  'utf-8',
);
const NOW = new Date('2026-07-21T00:00:00.000Z');

/** A stub SafeFetchResponse for the injected dispatch. */
function stubResponse(opts: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}): SafeFetchResponse {
  const body = opts.body ?? '';
  return {
    status: opts.status ?? 200,
    headers: new Headers(opts.headers ?? { 'content-type': 'application/json' }),
    url: 'https://registry.test/graph',
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer as ArrayBuffer;
    },
  };
}

/**
 * Build deps whose dispatch returns a fixed response. `resolve` returns a public
 * IP so the safeFetch guard passes; the host is validated but never re-derived
 * from the request.
 */
function depsReturning(response: SafeFetchResponse): { deps: SafeFetchDeps; dispatch: Mock } {
  const dispatch = vi.fn(async () => response);
  return {
    deps: { resolve: vi.fn(async () => ['93.184.216.34']), dispatch },
    dispatch,
  };
}

/** Build deps whose dispatch honours the abort signal (for the timeout path). */
function depsThatHang(): SafeFetchDeps {
  return {
    resolve: vi.fn(async () => ['93.184.216.34']),
    dispatch: vi.fn(
      (_ip: string, _url: string, init: RequestInit) =>
        new Promise<SafeFetchResponse>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    ),
  };
}

interface BuildAppOptions {
  deps: SafeFetchDeps;
  registryTimeoutMs?: number;
  authUserId?: string | null;
}

function buildApp(opts: BuildAppOptions) {
  const app = express();
  // Inject an auth identity the way router.ts's requireAuth would, so the
  // handler's defensive auth guard sees (or does not see) a caller.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (opts.authUserId !== null) req.authUserId = opts.authUserId ?? 'user-123';
    next();
  });
  app.use(
    '/',
    buildCredentialsCtdlImportRouter({
      deps: opts.deps,
      now: () => NOW,
      registryTimeoutMs: opts.registryTimeoutMs ?? 8000,
    }),
  );
  return app;
}

beforeEach(() => {
  insertAudit.mockReset();
  insertAudit.mockResolvedValue({ error: null });
  loggerWarn.mockReset();
  loggerError.mockReset();
  loggerInfo.mockReset();
});

describe('GET /credentials/ctdl/import — happy path', () => {
  it('fetches the CE graph envelope and returns exactly the credential record', async () => {
    const { deps, dispatch } = depsReturning(stubResponse({ body: GRAPH_RAW }));
    const app = buildApp({ deps });

    const res = await request(app).get('/').query({ ctid: CRED_CTID });

    expect(res.status).toBe(200);
    expect(res.body.ctid).toBe(CRED_CTID);
    expect(res.body.count).toBe(1);
    expect(res.body.records).toHaveLength(1);

    const record = res.body.records[0];
    expect(record.type).toBe('ceterms:Certification');
    expect(record.name).toBe('Electronics');
    expect(record.sourceId).toBe(CRED_CTID);
    // Issuer resolved (from the graph, cross-@id), no junk org records.
    expect(record.issuer).not.toBeNull();
    expect(record.retrievedAt).toBe(NOW.toISOString());

    // Provenance envelope fingerprint is the SHA-256 of the EXACT bytes fetched.
    expect(res.body.registry.envelopeSha256).toBe(
      createHash('sha256').update(GRAPH_RAW, 'utf8').digest('hex'),
    );
    // Measured-only: never asserted as CE endorsement.
    expect(res.body.registry.envelopeSignatureVerified).toBeNull();

    // The dispatch host was built server-side, never from the request.
    const calledUrl = dispatch.mock.calls[0][1] as string;
    expect(calledUrl).toContain(`/graph/${CRED_CTID}`);
    expect(calledUrl.startsWith('https://')).toBe(true);
  });

  it('never leaks the raw registry bytes into any log call (§1.6A)', async () => {
    const { deps } = depsReturning(stubResponse({ body: GRAPH_RAW }));
    const app = buildApp({ deps });
    await request(app).get('/').query({ ctid: CRED_CTID });

    const allLogArgs = [...loggerWarn.mock.calls, ...loggerError.mock.calls, ...loggerInfo.mock.calls]
      .flat()
      .map((a) => JSON.stringify(a))
      .join('\n');
    // A distinctive substring from the fixture body must never appear in logs.
    expect(allLogArgs).not.toContain('Electronics');
    expect(allLogArgs).not.toContain('ceterms:');
  });
});

describe('GET /credentials/ctdl/import — auth', () => {
  it('401s when there is no authenticated caller', async () => {
    const { deps, dispatch } = depsReturning(stubResponse({ body: GRAPH_RAW }));
    const app = buildApp({ deps, authUserId: null });
    const res = await request(app).get('/').query({ ctid: CRED_CTID });
    expect(res.status).toBe(401);
    // No outbound fetch is ever attempted for an unauthenticated caller.
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('GET /credentials/ctdl/import — SSRF guard (validate before any fetch)', () => {
  const HOSTILE_CTIDS = [
    'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b@evil.com',
    'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b/../../secret',
    'http://169.254.169.254/latest/meta-data/',
    'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b#@evil.com',
    'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b?x=1',
    'ce-not-a-uuid',
    '../ce-a4c0a549-aed3-4704-ade2-e81a5d76865b',
    'ce-a4c0a549-aed3-4704-ade2-e81a5d76865b ', // trailing space
  ];

  for (const hostile of HOSTILE_CTIDS) {
    it(`rejects hostile ctid before any fetch: ${JSON.stringify(hostile)}`, async () => {
      const { deps, dispatch } = depsReturning(stubResponse({ body: GRAPH_RAW }));
      const app = buildApp({ deps });
      const res = await request(app).get('/').query({ ctid: hostile });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_ctid');
      expect(dispatch).not.toHaveBeenCalled();
      expect(deps.resolve).not.toHaveBeenCalled();
    });
  }

  it('400s when ctid is missing entirely', async () => {
    const { deps, dispatch } = depsReturning(stubResponse({ body: GRAPH_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).get('/');
    expect(res.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('400s when ctid is provided as an array (query param pollution)', async () => {
    const { deps, dispatch } = depsReturning(stubResponse({ body: GRAPH_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).get('/?ctid=ce-a4c0a549-aed3-4704-ade2-e81a5d76865b&ctid=evil');
    expect(res.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('GET /credentials/ctdl/import — upstream error mapping', () => {
  it('maps registry 404 → 404', async () => {
    const { deps } = depsReturning(stubResponse({ status: 404, body: 'not found' }));
    const app = buildApp({ deps });
    const res = await request(app).get('/').query({ ctid: CRED_CTID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('registry_record_not_found');
  });

  it('maps registry 5xx → 502', async () => {
    const { deps } = depsReturning(stubResponse({ status: 503, body: 'upstream boom' }));
    const app = buildApp({ deps });
    const res = await request(app).get('/').query({ ctid: CRED_CTID });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('registry_bad_gateway');
  });

  it('maps malformed JSON → 422', async () => {
    const { deps } = depsReturning(stubResponse({ body: '{ this is : not json' }));
    const app = buildApp({ deps });
    const res = await request(app).get('/').query({ ctid: CRED_CTID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('registry_record_unparseable');
  });

  it('maps an oversize response body → 413', async () => {
    // Body larger than the 5 MiB cap — the safeFetch size guard rejects it.
    const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
    const { deps } = depsReturning(stubResponse({ body: huge }));
    const app = buildApp({ deps });
    const res = await request(app).get('/').query({ ctid: CRED_CTID });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('registry_record_too_large');
  });

  it('maps a redirect (no auto-follow to another host) → 502', async () => {
    const { deps } = depsReturning(
      stubResponse({ status: 302, headers: { location: 'https://evil.example.com/x' } }),
    );
    const app = buildApp({ deps });
    const res = await request(app).get('/').query({ ctid: CRED_CTID });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('registry_bad_gateway');
  });

  it('maps a fetch timeout → 504', async () => {
    const app = buildApp({ deps: depsThatHang(), registryTimeoutMs: 15 });
    const res = await request(app).get('/').query({ ctid: CRED_CTID });
    expect(res.status).toBe(504);
    expect(res.body.error).toBe('registry_timeout');
  });
});
