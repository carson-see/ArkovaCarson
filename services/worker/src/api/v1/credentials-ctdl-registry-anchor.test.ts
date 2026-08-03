/**
 * L3-A6 — CE Noncredit Data Taxonomy 3.0 anchoring POC route tests.
 *
 * `POST /api/v1/credentials/ctdl/registry-anchor` fetches a public CE Registry
 * `/graph/<ctid>` envelope (reusing the exact `fetchRegistryGraph` /
 * `buildRegistryGraphUrl` primitives from `credentials-ctdl-import.ts`),
 * parses it with `credentialNodesOnly: true, includeNoncreditProgramClasses:
 * true` (this PR's noncredit-parser fix), and creates an anchor from the
 * in-memory envelope SHA-256 + bounded PII-free metadata. The outbound fetch
 * is mocked (the noncredit template fixture bytes are fed back) — no real
 * network is ever touched.
 *
 * Mock shape mirrors `credential-sources.test.ts` (mock `../../config.js` +
 * `../../utils/orgCredits.js` + `../../lib/urls.js` directly) so tests never
 * load the real config singleton, which requires prod secrets at import time.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import { buildCredentialsCtdlRegistryAnchorRouter } from './credentials-ctdl-registry-anchor.js';
import { buildSelfImportRecipientHash } from '../../lib/credential-source-import.js';
import type { SafeFetchDeps, SafeFetchResponse } from '../../lib/safe-fetch.js';

const {
  mockFrom,
  mockProfileSingle,
  mockAnchorsMaybeSingle,
  mockAnchorInsert,
  mockAnchorInsertSingle,
  mockAnchorUpdate,
  mockAnchorUpdateChain,
  mockAuditInsert,
  mockRecipientInsert,
  mockRecipientDeleteMatch,
  mockDeductOrgCredit,
  loggerWarn,
  loggerError,
  loggerInfo,
} = vi.hoisted(() => {
  const mockProfileSingle = vi.fn();
  const mockAnchorsMaybeSingle = vi.fn();
  const mockAnchorInsertSingle = vi.fn();
  const mockAnchorInsert = vi.fn();
  const mockAnchorUpdateChain = vi.fn();
  const mockAnchorUpdate = vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        is: mockAnchorUpdateChain,
      })),
    })),
  }));
  const mockAuditInsert = vi.fn();
  const mockRecipientInsert = vi.fn();
  const mockRecipientDeleteMatch = vi.fn();
  const mockDeductOrgCredit = vi.fn();

  const mockFrom = vi.fn((table: string) => {
    if (table === 'profiles') {
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockProfileSingle })) })) };
    }
    if (table === 'anchors') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              is: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn(() => ({ maybeSingle: mockAnchorsMaybeSingle })),
                })),
              })),
            })),
          })),
        })),
        insert: mockAnchorInsert,
        update: mockAnchorUpdate,
      };
    }
    if (table === 'anchor_recipients') {
      return {
        insert: mockRecipientInsert,
        delete: vi.fn(() => ({ match: mockRecipientDeleteMatch })),
      };
    }
    if (table === 'audit_events') {
      return { insert: mockAuditInsert };
    }
    return { select: vi.fn() };
  });

  return {
    mockFrom,
    mockProfileSingle,
    mockAnchorsMaybeSingle,
    mockAnchorInsert,
    mockAnchorInsertSingle,
    mockAnchorUpdate,
    mockAnchorUpdateChain,
    mockAuditInsert,
    mockRecipientInsert,
    mockRecipientDeleteMatch,
    mockDeductOrgCredit,
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerInfo: vi.fn(),
  };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: vi.fn() },
}));

vi.mock('../../utils/orgCredits.js', () => ({
  deductOrgCredit: mockDeductOrgCredit,
}));

vi.mock('../../lib/urls.js', () => ({
  buildVerifyUrl: (publicId: string) => `https://app.test/verify/${publicId}`,
}));

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'ctdl', '__fixtures__');
const NONCREDIT_RAW = fs.readFileSync(
  path.join(FIXTURES_DIR, 'ce-template-noncredit-learning-program.json'),
  'utf-8',
);
const PROGRAM_CTID = 'ce-00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-28T00:00:00.000Z');
const ENVELOPE_SHA256 = createHash('sha256').update(NONCREDIT_RAW, 'utf8').digest('hex');

function stubResponse(opts: { status?: number; body?: string; headers?: Record<string, string> }): SafeFetchResponse {
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

function depsReturning(response: SafeFetchResponse): { deps: SafeFetchDeps; dispatch: Mock } {
  const dispatch = vi.fn(async () => response);
  return { deps: { resolve: vi.fn(async () => ['93.184.216.34']), dispatch }, dispatch };
}

interface BuildAppOptions {
  deps: SafeFetchDeps;
  authUserId?: string | null;
}

function buildApp(opts: BuildAppOptions) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (opts.authUserId !== null) req.authUserId = opts.authUserId ?? 'user-123';
    next();
  });
  app.use(
    '/',
    buildCredentialsCtdlRegistryAnchorRouter({
      deps: opts.deps,
      now: () => NOW,
      registryTimeoutMs: 8000,
    }),
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProfileSingle.mockResolvedValue({ data: { org_id: null }, error: null });
  mockAnchorsMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockAnchorUpdateChain.mockResolvedValue({ error: null });
  mockAnchorInsert.mockImplementation((payload: unknown) => ({
    select: vi.fn(() => ({
      single: mockAnchorInsertSingle.mockResolvedValue({
        data: {
          id: 'anchor-1',
          public_id: 'ARK-2026-ABCD1234',
          fingerprint: (payload as { fingerprint: string }).fingerprint,
          status: 'PENDING',
          created_at: NOW.toISOString(),
        },
        error: null,
      }),
    })),
  }));
  mockAuditInsert.mockResolvedValue({ error: null });
  mockRecipientInsert.mockResolvedValue({ error: null });
  mockRecipientDeleteMatch.mockResolvedValue({ error: null });
  mockDeductOrgCredit.mockResolvedValue({ allowed: true, reason: 'feature_disabled' });
});

describe('POST /credentials/ctdl/registry-anchor — happy path', () => {
  it('creates an anchor from the noncredit LearningProgram registry record', async () => {
    const { deps, dispatch } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });

    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.anchor.public_id).toBe('ARK-2026-ABCD1234');
    expect(res.body.anchor.record_uri).toBe('https://app.test/verify/ARK-2026-ABCD1234');
    expect(res.body.registry.ctid).toBe(PROGRAM_CTID);
    expect(res.body.registry.envelopeSha256).toBe(ENVELOPE_SHA256);
    expect(res.body.registry.envelopeSignatureVerified).toBeNull();
    expect(res.body.record.type).toBe('ceterms:LearningProgram');
    expect(res.body.record.name).toBe('Certified Production Technician Noncredit Program');
    expect(res.body.record.issuerName).toBe('Example Community College');

    const calledUrl = dispatch.mock.calls[0][1] as string;
    expect(calledUrl).toContain(`/graph/${PROGRAM_CTID}`);

    const insertCall = mockAnchorInsert.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
      credential_type: string;
    };
    expect(insertCall.metadata.ce_registry_ctid).toBe(PROGRAM_CTID);
    expect(insertCall.metadata.ce_envelope_sha256).toBe(ENVELOPE_SHA256);
    expect(insertCall.metadata.ce_record_type).toBe('ceterms:LearningProgram');
    expect(insertCall.credential_type).toBe('OTHER');
  });

  it('never leaks the raw registry bytes into any log call (§1.6A)', async () => {
    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    await request(app).post('/').send({ ctid: PROGRAM_CTID });

    const allLogArgs = [...loggerWarn.mock.calls, ...loggerError.mock.calls, ...loggerInfo.mock.calls]
      .flat()
      .map((a) => JSON.stringify(a))
      .join('\n');
    expect(allLogArgs).not.toContain('Certified Production Technician');
    expect(allLogArgs).not.toContain('ceterms:');
  });
});

describe('POST /credentials/ctdl/registry-anchor — auth + validation', () => {
  it('401s when there is no authenticated caller', async () => {
    const { deps, dispatch } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps, authUserId: null });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('400s on an invalid ctid before any fetch', async () => {
    const { deps, dispatch } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: 'ce-not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_ctid');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('400s on a malformed request body', async () => {
    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ not_ctid: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /credentials/ctdl/registry-anchor — publishability', () => {
  it('422s when the registry record has no admitted credential/noncredit node', async () => {
    const emptyGraph = JSON.stringify({
      '@context': 'https://credreg.net/ctdl/schema/context/json',
      '@graph': [
        { '@id': 'https://x/org', '@type': 'ceterms:CredentialOrganization', 'ceterms:name': { 'en-US': 'Org' } },
      ],
    });
    const { deps } = depsReturning(stubResponse({ body: emptyGraph }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_publishable_record');
    expect(mockAnchorInsert).not.toHaveBeenCalled();
  });
});

describe('POST /credentials/ctdl/registry-anchor — staleness guard', () => {
  it('409s when expected_envelope_sha256 no longer matches the fetched bytes', async () => {
    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app)
      .post('/')
      .send({ ctid: PROGRAM_CTID, expected_envelope_sha256: 'a'.repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('registry_record_changed');
    expect(mockAnchorInsert).not.toHaveBeenCalled();
  });

  it('proceeds when expected_envelope_sha256 matches', async () => {
    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app)
      .post('/')
      .send({ ctid: PROGRAM_CTID, expected_envelope_sha256: ENVELOPE_SHA256 });
    expect(res.status).toBe(201);
  });
});

describe('POST /credentials/ctdl/registry-anchor — idempotency', () => {
  it('returns duplicate:true and does NOT insert a second anchor for the same registry state', async () => {
    mockAnchorsMaybeSingle.mockResolvedValue({
      data: {
        id: 'anchor-existing',
        public_id: 'ARK-2026-EXIST001',
        fingerprint: 'f'.repeat(64),
        status: 'PENDING',
        created_at: NOW.toISOString(),
      },
      error: null,
    });
    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.anchor.public_id).toBe('ARK-2026-EXIST001');
    expect(mockAnchorInsert).not.toHaveBeenCalled();
  });
});

describe('POST /credentials/ctdl/registry-anchor — upstream error mapping', () => {
  it('maps registry 404 → 404', async () => {
    const { deps } = depsReturning(stubResponse({ status: 404, body: 'not found' }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('registry_record_not_found');
  });

  it('maps registry 5xx → 502', async () => {
    const { deps } = depsReturning(stubResponse({ status: 503, body: 'upstream boom' }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('registry_bad_gateway');
  });
});

/**
 * Recipient linkage — the bug this suite exists to pin.
 *
 * `get_my_credentials()` (the RPC behind `useMyCredentials` / the
 * `/my-credentials` page) is a STRICT INNER JOIN with no `anchors.user_id`
 * fallback:
 *
 *   FROM anchor_recipients ar JOIN anchors a ON a.id = ar.anchor_id
 *   WHERE ar.recipient_user_id = auth.uid() AND a.deleted_at IS NULL
 *
 * so an anchor created with `user_id` alone and no `anchor_recipients` row is
 * PERMANENTLY invisible to the user who just created it — not a cache/refresh
 * problem, there is structurally no row to join through. This route must write
 * the same self-recipient marker the sibling self-import path writes
 * (`credential-sources.ts` `linkSelfRecipient`), using the SHARED
 * `buildSelfImportRecipientHash` so both paths stay claim-compatible.
 */
describe('POST /credentials/ctdl/registry-anchor — recipient linkage (My Credentials visibility)', () => {
  const SELF_HASH = buildSelfImportRecipientHash('user-123');

  it('links the calling user as a recipient so the record is reachable via get_my_credentials()', async () => {
    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });

    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(201);
    expect(mockRecipientInsert).toHaveBeenCalledTimes(1);
    expect(mockRecipientInsert).toHaveBeenCalledWith({
      anchor_id: 'anchor-1',
      recipient_email_hash: SELF_HASH,
      recipient_user_id: 'user-123',
    });
  });

  it('links the recipient BEFORE deducting a credit — never charges for an invisible record', async () => {
    mockProfileSingle.mockResolvedValue({ data: { org_id: 'org-123' }, error: null });
    mockDeductOrgCredit.mockResolvedValue({ allowed: true, reason: 'deducted' });

    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(201);
    expect(mockRecipientInsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeductOrgCredit.mock.invocationCallOrder[0],
    );
  });

  it('rolls back the anchor and 500s when the recipient link fails — no orphaned invisible anchor', async () => {
    mockRecipientInsert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });

    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('anchor_create_failed');
    // Soft-deleted, so it cannot linger as an anchor no user can ever see.
    expect(mockAnchorUpdateChain).toHaveBeenCalled();
    // And nothing was charged for it.
    expect(mockDeductOrgCredit).not.toHaveBeenCalled();
  });

  it('treats a duplicate recipient row (23505) as already-linked and still returns 201', async () => {
    mockRecipientInsert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });

    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(201);
    expect(mockAnchorUpdateChain).not.toHaveBeenCalled();
  });

  it('links the recipient on the duplicate-anchor path — self-heals anchors created before this fix', async () => {
    mockAnchorsMaybeSingle.mockResolvedValue({
      data: {
        id: 'anchor-existing',
        public_id: 'ARK-2026-EXIST001',
        fingerprint: 'f'.repeat(64),
        status: 'PENDING',
        created_at: NOW.toISOString(),
      },
      error: null,
    });

    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(mockRecipientInsert).toHaveBeenCalledWith({
      anchor_id: 'anchor-existing',
      recipient_email_hash: SELF_HASH,
      recipient_user_id: 'user-123',
    });
  });

  it('unlinks the recipient when the credit gate rejects the anchor', async () => {
    mockProfileSingle.mockResolvedValue({ data: { org_id: 'org-123' }, error: null });
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });

    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(402);
    expect(mockRecipientDeleteMatch).toHaveBeenCalledWith({
      anchor_id: 'anchor-1',
      recipient_user_id: 'user-123',
    });
  });

  it('never writes the recipient hash into any log call', async () => {
    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    await request(app).post('/').send({ ctid: PROGRAM_CTID });

    const allLogArgs = [...loggerWarn.mock.calls, ...loggerError.mock.calls, ...loggerInfo.mock.calls]
      .flat()
      .map((a) => JSON.stringify(a))
      .join('\n');
    expect(allLogArgs).not.toContain(SELF_HASH);
  });
});

describe('POST /credentials/ctdl/registry-anchor — org credit gate', () => {
  it('rolls back the anchor and returns 402 when the org has insufficient credits', async () => {
    mockProfileSingle.mockResolvedValue({ data: { org_id: 'org-123' }, error: null });
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });

    const { deps } = depsReturning(stubResponse({ body: NONCREDIT_RAW }));
    const app = buildApp({ deps });
    const res = await request(app).post('/').send({ ctid: PROGRAM_CTID });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('insufficient_credits');
    // The anchor row created earlier in the request is rolled back (soft-deleted).
    expect(mockAnchorUpdate).toHaveBeenCalled();
    expect(mockAnchorUpdateChain).toHaveBeenCalled();
  });
});
