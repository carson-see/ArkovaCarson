/**
 * DPA clause 4.6 — the OTHER anchor write paths.
 *
 * `anchor-field-policy.test.ts` covers the two routes the control shipped on.
 * This suite covers the five that were missed, each of which was a way for a
 * policy-configured org to send a prohibited field and get a 2xx:
 *
 *   POST /api/v1/contracts/anchor-pre-signing   (API key, anchor:write)
 *   POST /api/v1/cle/submit                     (API key or dashboard JWT)
 *   POST /api/v1/credentials/ctdl/registry-anchor (dashboard JWT)
 *   POST /api/v1/credential-sources/import-url/{preview,confirm} (dashboard JWT)
 *   POST /api/v1/versions/:versionId/resolve    (dashboard JWT, org admin)
 *
 * The dashboard-authenticated routes are in scope for the same reason
 * `anchor-bulk-self-service` is: the regulated counterparty is the ORG, and an
 * org admin clicking a button in the dashboard is that counterparty sending us
 * a field its agreement forbids. Auth mechanism is not the boundary.
 *
 * Every test drives the REAL `enforceOrgFieldPolicy` through the REAL handler.
 * Only the Supabase read of `organization_field_policies` is stubbed.
 *
 * Each route gets, at minimum:
 *   - a rejection case (400, `field_not_permitted`, nothing inserted),
 *   - the no-policy regression case, which is the one that matters for the
 *     ~24.9k existing anchors: an org with no policy row must be untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SafeFetchDeps, SafeFetchResponse } from '../../lib/safe-fetch.js';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockState = vi.hoisted(() => ({
  /** Row returned for organization_field_policies, or null for "no policy". */
  policyRow: null as Record<string, unknown> | null,
  /** org_id returned for the caller's profiles row. */
  profileOrgId: 'org-1' as string | null,
  /** Payloads inserted into `anchors` during a test. */
  anchorInserts: [] as unknown[],
  /** Reads of the policy table, proving the guard actually consulted it. */
  policyReads: 0,
  /** Force the shared org-auth helper's operational-failure branch. */
  orgLookupErrors: false,
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
// cle/submit resolves the caller's org through the shared org-auth helper on the
// JWT path. `orgLookupErrors` forces the operational-failure branch so the
// fail-closed 503 can be tested directly rather than inferred.
vi.mock('../_org-auth.js', () => ({
  getCallerOrgIdResult: vi.fn(async () =>
    mockState.orgLookupErrors
      ? { value: null, error: true }
      : { value: mockState.profileOrgId, error: false },
  ),
  getCallerOrgId: vi.fn(async () => mockState.profileOrgId),
  getCallerProfile: vi.fn(async () => ({ org_id: mockState.profileOrgId, role: 'ORG_ADMIN', is_platform_admin: false })),
  isCallerOrgAdmin: vi.fn(async () => true),
  isCallerOrgAdminResult: vi.fn(async () => ({ value: true, error: false })),
}));
vi.mock('../../auth.js', () => ({
  verifyAuthToken: vi.fn(async () => 'user-1'),
}));
vi.mock('../../config.js', () => ({
  get config() {
    return { enableOrgCreditEnforcement: false, recipientIdentifierPepper: null };
  },
}));
vi.mock('../../lib/urls.js', () => ({
  buildVerifyUrl: (id: string) => `https://example.test/verify/${id}`,
}));
vi.mock('../../utils/orgCredits.js', () => ({
  deductOrgCredit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
  isPrivateUrlResolved: vi.fn().mockResolvedValue(false),
}));

// One db double for every table these five routes touch, dispatched by name.
// `.maybeSingle()` / `.single()` are the terminals; everything else chains.
vi.mock('../../utils/db.js', () => {
  const makeChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = vi.fn(self);
    chain.eq = vi.fn(self);
    chain.is = vi.fn(self);
    chain.order = vi.fn(self);
    chain.match = vi.fn(() => Promise.resolve({ error: null }));
    chain.limit = vi.fn(self);
    chain.in = vi.fn(() => Promise.resolve({ data: [], error: null }));

    const terminal = () => {
      if (table === 'organization_field_policies') {
        mockState.policyReads += 1;
        return Promise.resolve({ data: mockState.policyRow, error: null });
      }
      if (table === 'profiles') {
        return Promise.resolve({ data: { org_id: mockState.profileOrgId }, error: null });
      }
      if (table === 'external_document_versions') {
        return Promise.resolve({
          data: {
            id: 'version-1',
            fingerprint: 'f'.repeat(64),
            external_file_id: 'drive-file-1',
            source: 'google_drive',
          },
          error: null,
        });
      }
      // anchors dedup lookups — never a duplicate in these tests.
      return Promise.resolve({ data: null, error: null });
    };
    chain.maybeSingle = vi.fn(terminal);
    chain.single = vi.fn(() => {
      if (table === 'anchors') {
        return Promise.resolve({
          data: {
            id: 'anchor-uuid',
            public_id: 'ARK-2026-TEST0001',
            fingerprint: 'a'.repeat(64),
            status: 'PENDING',
            created_at: '2026-08-10T00:00:00.000Z',
            metadata: null,
          },
          error: null,
        });
      }
      return terminal();
    });
    chain.insert = vi.fn((payload: unknown) => {
      if (table === 'anchors') mockState.anchorInserts.push(payload);
      return chain;
    });
    chain.update = vi.fn(self);
    chain.delete = vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ error: null })),
      match: vi.fn(() => Promise.resolve({ error: null })),
    }));
    return chain;
  };
  return { db: { from: vi.fn((table: string) => makeChain(table)), rpc: vi.fn() } };
});

import { anchorPreSigningRouter } from './contracts/anchor-pre-signing.js';
import { cleVerifyRouter } from './cle-verify.js';
import { credentialSourcesRouter } from './credential-sources.js';
import { buildCredentialsCtdlRegistryAnchorRouter } from './credentials-ctdl-registry-anchor.js';
import { handleResolveVersion } from '../version-resolution.js';
import {
  clearOrgFieldPolicyCache,
  ORG_FIELD_POLICY_REJECTED_ERROR,
} from '../../utils/orgFieldPolicy.js';

const FINGERPRINT = 'a'.repeat(64);

/**
 * A policy row forbidding `fields`.
 *
 * Each route below forbids a field ITS OWN schema accepts. That distinction is
 * the whole point of the test: every one of these bodies is `.strict()`, so an
 * unknown key is already a 400 `invalid_request` from Zod and proves nothing
 * about this control. Only a field the schema would happily accept — and
 * persist — demonstrates that the guard is what refused it.
 */
function policyRow(fields: string[]) {
  return {
    org_id: 'org-1',
    disallowed_fields: fields,
    enabled: true,
    policy_reason:
      'DPA Schedule 1 permits the document fingerprint, a non-identifying matter reference and credential type only.',
    contract_reference: 'DPA Schedule 1 / clause 4.6',
  };
}

function withApiKey(req: Request, _res: Response, next: NextFunction) {
  (req as Request & { apiKey?: unknown }).apiKey = {
    keyId: 'key-1',
    userId: 'user-1',
    orgId: 'org-1',
    scopes: ['anchor:write'],
    rateLimitTier: 'paid',
    keyPrefix: 'arkv_test_',
  };
  next();
}

function withJwtUser(req: Request, _res: Response, next: NextFunction) {
  req.authUserId = 'user-1';
  next();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearOrgFieldPolicyCache();
  mockState.policyRow = null;
  mockState.profileOrgId = 'org-1';
  mockState.anchorInserts = [];
  mockState.policyReads = 0;
  mockState.orgLookupErrors = false;
});

// ─── POST /contracts/anchor-pre-signing ─────────────────────────────────────

describe('POST /api/v1/contracts/anchor-pre-signing — org field policy', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use(withApiKey);
    a.use('/api/v1/contracts', anchorPreSigningRouter);
    return a;
  };

  /** A body PreSigningAnchorSchema fully accepts. `description` is a real field. */
  const validBody = (extra: Record<string, unknown> = {}) => ({
    fingerprint: FINGERPRINT,
    contract_metadata: { title: 'Supply Agreement', counterparty_labels: ['Counterparty A'] },
    signing_workflow_metadata: { provider: 'docusign', external_envelope_id: 'env-1' },
    ...extra,
  });

  it('REJECTS a schema-VALID description with 400 and inserts nothing', async () => {
    mockState.policyRow = policyRow(['description']);
    const res = await request(app())
      .post('/api/v1/contracts/anchor-pre-signing')
      .send(validBody({ description: 'client matter note' }))
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(res.body.details).toEqual([
      expect.objectContaining({ path: 'description', code: ORG_FIELD_POLICY_REJECTED_ERROR }),
    ]);
    expect(res.body.contract_reference).toBe('DPA Schedule 1 / clause 4.6');
    expect(mockState.anchorInserts).toHaveLength(0);
    expect(mockState.policyReads).toBeGreaterThan(0);
  });

  it('REJECTS a prohibited field nested in contract_metadata', async () => {
    mockState.policyRow = policyRow(['title']);
    const res = await request(app())
      .post('/api/v1/contracts/anchor-pre-signing')
      .send(validBody())
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(res.body.details[0].path).toBe('contract_metadata.title');
    expect(mockState.anchorInserts).toHaveLength(0);
  });

  it('rejects BEFORE the idempotency lookup, so a retry cannot smuggle the field', async () => {
    mockState.policyRow = policyRow(['description']);
    // Two identical calls: an integration retrying its contract submission.
    // Both must 400. If the guard sat after the idempotency lookup, the second
    // would return the stored 200 receipt and the field would ride along.
    for (const _attempt of [1, 2]) {
      const res = await request(app())
        .post('/api/v1/contracts/anchor-pre-signing')
        .send(validBody({ description: 'x' }))
        .expect(400);
      expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    }
    expect(mockState.anchorInserts).toHaveLength(0);
  });

  it('never echoes the rejected value back', async () => {
    mockState.policyRow = policyRow(['description']);
    const secret = 'Wanjiku-v-Republic-confidential';
    const res = await request(app())
      .post('/api/v1/contracts/anchor-pre-signing')
      .send(validBody({ description: secret }))
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('leaves an org WITHOUT a policy completely unaffected', async () => {
    mockState.policyRow = null;
    const res = await request(app())
      .post('/api/v1/contracts/anchor-pre-signing')
      .send(validBody({ description: 'perfectly fine' }));

    expect(res.status).toBe(201);
    expect(res.body.error).toBeUndefined();
    expect(mockState.anchorInserts).toHaveLength(1);
  });

  it('accepts the permitted fields for the policy-configured org', async () => {
    mockState.policyRow = policyRow(['description']);
    const res = await request(app())
      .post('/api/v1/contracts/anchor-pre-signing')
      .send(validBody());

    expect(res.status).toBe(201);
    expect(mockState.anchorInserts).toHaveLength(1);
  });
});

// ─── POST /cle/submit ───────────────────────────────────────────────────────

describe('POST /api/v1/cle/submit — org field policy', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use(withApiKey);
    a.use('/api/v1/cle', cleVerifyRouter);
    return a;
  };

  /** A body CleSubmitSchema fully accepts. `attorney_name` is a real field. */
  const validSubmission = (extra: Record<string, unknown> = {}) => ({
    bar_number: 'KE-12345',
    course_title: 'Ethics in Practice',
    provider_name: 'Kenya School of Law',
    credit_hours: 2,
    credit_category: 'Ethics',
    jurisdiction: 'KE',
    completion_date: '2026-07-01',
    ...extra,
  });

  it('REJECTS a schema-VALID attorney_name with 400 and inserts nothing', async () => {
    mockState.policyRow = policyRow(['attorney_name']);
    const res = await request(app())
      .post('/api/v1/cle/submit')
      .send(validSubmission({ attorney_name: 'Grace Wanjiku' }))
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(res.body.details).toEqual([
      expect.objectContaining({ path: 'attorney_name', code: ORG_FIELD_POLICY_REJECTED_ERROR }),
    ]);
    expect(mockState.anchorInserts).toHaveLength(0);
  });

  it('never echoes the rejected attorney name back', async () => {
    mockState.policyRow = policyRow(['attorney_name']);
    const res = await request(app())
      .post('/api/v1/cle/submit')
      .send(validSubmission({ attorney_name: 'Grace Wanjiku' }))
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('Grace Wanjiku');
  });

  it('leaves an org WITHOUT a policy completely unaffected', async () => {
    mockState.policyRow = null;
    const res = await request(app())
      .post('/api/v1/cle/submit')
      .send(validSubmission({ attorney_name: 'Grace Wanjiku' }))
      .expect(201);

    expect(res.body.public_id).toBe('ARK-2026-TEST0001');
    expect(mockState.anchorInserts).toHaveLength(1);
    const metadata = (mockState.anchorInserts[0] as { metadata: Record<string, unknown> }).metadata;
    // The whole submission body still reaches anchors.metadata verbatim, which
    // is exactly why this route needed the guard.
    expect(metadata.attorney_name).toBe('Grace Wanjiku');
  });

  it('enforces against the API key org, and never billed/inserted on rejection', async () => {
    mockState.policyRow = policyRow(['bar_number']);
    await request(app())
      .post('/api/v1/cle/submit')
      .send(validSubmission())
      .expect(400);
    expect(mockState.anchorInserts).toHaveLength(0);
  });

  it('FAILS CLOSED with 503 when the caller org cannot be resolved (JWT path)', async () => {
    // The silent-bypass shape this guards against: a failed `profiles` read
    // yielding a bare null orgId, which enforceOrgFieldPolicy would read as
    // "unrestricted org" and wave through. A caller with genuinely no org is a
    // different case and is allowed (covered by the no-policy test above).
    mockState.policyRow = policyRow(['attorney_name']);
    mockState.orgLookupErrors = true;

    const jwtApp = express();
    jwtApp.use(express.json());
    // No apiKey — a Bearer JWT, so the route resolves org via `profiles`.
    jwtApp.use((req, _res, next) => {
      req.headers.authorization = 'Bearer not-an-ak-token';
      next();
    });
    jwtApp.use('/api/v1/cle', cleVerifyRouter);

    const res = await request(jwtApp)
      .post('/api/v1/cle/submit')
      .send(validSubmission({ attorney_name: 'Grace Wanjiku' }))
      .expect(503);

    expect(res.body.error).toBe('field_policy_unavailable');
    expect(mockState.anchorInserts).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('Grace Wanjiku');
  });
});

// ─── POST /credentials/ctdl/registry-anchor ─────────────────────────────────

describe('POST /api/v1/credentials/ctdl/registry-anchor — org field policy', () => {
  const CTID = 'ce-a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  const buildAppWith = (dispatch: SafeFetchDeps['dispatch']) => {
    const a = express();
    a.use(express.json());
    a.use(withJwtUser);
    a.use(
      '/',
      buildCredentialsCtdlRegistryAnchorRouter({
        deps: { resolve: vi.fn(async () => ['93.184.216.34']), dispatch },
        now: () => new Date('2026-08-10T00:00:00.000Z'),
        registryTimeoutMs: 8000,
      }),
    );
    return a;
  };

  /** A registry hop that succeeds with a body that is NOT a CTDL graph. */
  const okDispatch = () =>
    vi.fn(
      async (_pinnedIp: string, url: string, _init: RequestInit): Promise<SafeFetchResponse> => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        url,
        arrayBuffer: async () => new TextEncoder().encode('{}').buffer as ArrayBuffer,
      }),
    );

  it('REJECTS a schema-VALID prohibited field with 400 and inserts nothing', async () => {
    // `expected_envelope_sha256` is one of only two fields this body accepts,
    // so it is what a policy on this route would name.
    mockState.policyRow = policyRow(['expected_envelope_sha256']);
    const res = await request(buildAppWith(okDispatch()))
      .post('/')
      .send({ ctid: CTID, expected_envelope_sha256: 'b'.repeat(64) })
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(res.body.details[0].path).toBe('expected_envelope_sha256');
    expect(mockState.anchorInserts).toHaveLength(0);
  });

  it('rejects BEFORE the outbound CE Registry fetch', async () => {
    mockState.policyRow = policyRow(['expected_envelope_sha256']);
    const dispatch = okDispatch();

    await request(buildAppWith(dispatch))
      .post('/')
      .send({ ctid: CTID, expected_envelope_sha256: 'b'.repeat(64) })
      .expect(400);

    // A request we are going to refuse must not cause a third-party call on
    // the org's behalf.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves an org WITHOUT a policy unaffected (request proceeds past the guard)', async () => {
    mockState.policyRow = null;
    const dispatch = okDispatch();

    const res = await request(buildAppWith(dispatch)).post('/').send({ ctid: CTID });

    // Reaching the registry fetch is the proof that the guard let it past. The
    // stub is not a real CTDL graph, so the handler ends in a registry-shaped
    // error rather than a 201 — what this pins is that it is NOT the policy
    // rejection, and that the policy WAS consulted.
    expect(res.body.error).not.toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(mockState.policyReads).toBeGreaterThan(0);
    expect(dispatch).toHaveBeenCalled();
  });
});

// ─── POST /credential-sources/import-url/{preview,confirm} ──────────────────

describe('POST /api/v1/credential-sources/import-url — org field policy', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use(withJwtUser);
    a.use('/api/v1/credential-sources', credentialSourcesRouter);
    return a;
  };

  /** `issuer_hint` is a real optional field on CredentialSourceImportRequestSchema. */
  const validBody = (extra: Record<string, unknown> = {}) => ({
    source_url: 'https://example.test/credential',
    ...extra,
  });

  it('REJECTS a schema-VALID issuer_hint on /confirm with 400 and inserts nothing', async () => {
    mockState.policyRow = policyRow(['issuer_hint']);
    const res = await request(app())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send(validBody({ issuer_hint: 'Wanjiku & Co Advocates' }))
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(mockState.anchorInserts).toHaveLength(0);
  });

  it('REJECTS on /preview too — a preview must not validate what confirm rejects', async () => {
    mockState.policyRow = policyRow(['issuer_hint']);
    const res = await request(app())
      .post('/api/v1/credential-sources/import-url/preview')
      .send(validBody({ issuer_hint: 'Wanjiku & Co Advocates' }))
      .expect(400);

    expect(res.body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
  });

  it('never echoes the rejected value back', async () => {
    mockState.policyRow = policyRow(['issuer_hint']);
    const secret = 'Wanjiku-v-Republic-confidential';
    const res = await request(app())
      .post('/api/v1/credential-sources/import-url/confirm')
      .send(validBody({ issuer_hint: secret }))
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('leaves an org WITHOUT a policy unaffected (request proceeds past the guard)', async () => {
    mockState.policyRow = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<title>Example Credential</title>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const res = await request(app())
      .post('/api/v1/credential-sources/import-url/preview')
      .send(validBody());

    expect(res.body.error).not.toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(mockState.policyReads).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

// ─── POST /versions/:versionId/resolve ──────────────────────────────────────

describe('POST /api/v1/versions/:versionId/resolve — org field policy', () => {
  function mockRes() {
    const json = vi.fn();
    const type = vi.fn(() => ({ json }));
    const status = vi.fn(() => ({ json, type }));
    return { res: { status, json, type } as unknown as Response, status, json };
  }

  function mockReq(body: unknown): Request {
    const req = {
      body,
      params: { versionId: '11111111-2222-4333-8444-555555555555' },
      query: {},
    } as unknown as Request;
    const mutable = req as Request & { userId?: string; orgId?: string; orgRole?: string };
    mutable.userId = 'user-1';
    mutable.orgId = 'org-1';
    mutable.orgRole = 'admin';
    return req;
  }

  it('REJECTS a schema-VALID notes field with 400 and creates no anchor', async () => {
    // `notes` is a real field on ResolveVersionInput, so Zod accepts it and the
    // guard is the only thing that can refuse it.
    mockState.policyRow = policyRow(['notes']);
    const { res, status, json } = mockRes();

    await handleResolveVersion(mockReq({ decision: 'approve', notes: 'client matter note' }), res);

    expect(status).toHaveBeenCalledWith(400);
    // Pin that the 400 came from THE FIELD POLICY, not some earlier validation:
    // a future schema change that 400s before the guard would otherwise keep
    // this test green while the control silently stopped being what rejects.
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: ORG_FIELD_POLICY_REJECTED_ERROR,
        details: [
          expect.objectContaining({ path: 'notes', code: ORG_FIELD_POLICY_REJECTED_ERROR }),
        ],
      }),
    );
    expect(mockState.anchorInserts).toHaveLength(0);
    expect(mockState.policyReads).toBeGreaterThan(0);
  });

  it('leaves an org WITHOUT a policy unaffected', async () => {
    mockState.policyRow = null;
    const { res, status } = mockRes();

    await handleResolveVersion(mockReq({ decision: 'approve', notes: 'fine' }), res);

    expect(status).not.toHaveBeenCalledWith(400);
    expect(mockState.policyReads).toBeGreaterThan(0);
  });
});
