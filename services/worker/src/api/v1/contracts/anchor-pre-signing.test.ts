/**
 * SCRUM-1631 [Build] tests — POST /api/v1/contracts/anchor-pre-signing
 *
 * The [Spec] subtask (SCRUM-1629) shipped 24 shape-pinning tests against
 * the 501 stub. [Build] swaps the stub for the real handler and updates
 * the success-path expectations to 201/200 + adds coverage for:
 *   - Idempotency (existing fingerprint → 200, no insert, no credit charge)
 *   - Org-credit deduction (insufficient → 402, RPC failure → 503)
 *   - The exact insertPayload shape (credential_type, metadata jsonb)
 *
 * The shape-pinning tests inherited from [Spec] still hold the line on
 * request-shape contract (CLAUDE.md §1.8 frozen schema).
 *
 * The router-level scope-gate test (SCRUM-1629 / CodeRabbit major) and the
 * direct PreSigningAnchorSchema tests are unchanged — they pin contract
 * surface that has nothing to do with [Build]'s handler logic swap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Hoist only the controllable handles. The supabase chain itself gets
// assembled inside the vi.mock factory below — that keeps this file's
// mock setup distinct from anchor-submit.test.ts (SonarCloud's New-Code
// duplication detector flagged the prior verbatim-match shape on PR #680).
//
// `chainEq` + `chainIs` are exposed so cross-tenant tests can assert the
// idempotency lookup filtered on org_id (CodeRabbit critical on PR #680).
const {
  selectMaybeSingle,
  insertSingle,
  mockInsert,
  chainEq,
  chainIs,
  mockLogger,
  mockConfig,
  mockDeductOrgCredit,
} = vi.hoisted(() => {
  const selectMaybeSingle = vi.fn();
  const insertSingle = vi.fn();
  const mockInsert = vi.fn((_value?: unknown) => ({
    select: vi.fn(() => ({ single: insertSingle })),
  }));
  // Single shared spy per chain method — every chained `.eq()` / `.is()`
  // appends to its `.mock.calls` so the test can assert the full set of
  // filters applied.
  const chainEq = vi.fn();
  const chainIs = vi.fn();
  return {
    selectMaybeSingle,
    insertSingle,
    mockInsert,
    chainEq,
    chainIs,
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockConfig: { enableOrgCreditEnforcement: false },
    mockDeductOrgCredit: vi.fn(),
  };
});

vi.mock('../../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('../../../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../../utils/db.js', () => {
  // Build the fluent chain inside the factory. The chain methods are
  // hoisted spies (chainEq, chainIs) so cross-tenant tests can assert
  // the org_id filter was applied. Each spy returns the chain so further
  // calls keep working.
  const buildSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = chainEq.mockReturnValue(undefined as unknown);
    chain.is = chainIs.mockReturnValue(undefined as unknown);
    // The spies need to actually return the chain object so the handler's
    // fluent chaining (.eq(...).eq(...).is(...).maybeSingle()) keeps
    // working. We re-bind here so the previous mockReturnValue is replaced
    // with the proper chain reference.
    chainEq.mockImplementation(() => chain);
    chainIs.mockImplementation(() => chain);
    chain.maybeSingle = selectMaybeSingle;
    return chain;
  };
  return {
    db: {
      from: vi.fn(() => ({
        select: vi.fn(buildSelectChain),
        insert: mockInsert,
      })),
    },
  };
});

vi.mock('../../../lib/urls.js', () => ({
  buildVerifyUrl: (id: string) => `https://example.test/verify/${id}`,
}));

vi.mock('../../../utils/orgCredits.js', () => ({
  deductOrgCredit: mockDeductOrgCredit,
}));

import { anchorPreSigningRouter, PreSigningAnchorSchema } from './anchor-pre-signing.js';
import { requireScope } from '../../../middleware/apiKeyAuth.js';

function makeApp(opts: { withApiKey?: boolean; orgId?: string | null } = {}) {
  const { withApiKey = true, orgId = 'org-1' } = opts;
  const app = express();
  app.use(express.json());
  if (withApiKey) {
    app.use((req, _res, next) => {
      // Cast through `unknown` so the orgId=null branch (intentional test
      // for the handler's "skip credit deduction when no orgId" path) can
      // bypass the ApiKeyMeta type's `orgId: string` declaration. The
      // handler defends against missing orgId at runtime regardless.
      const apiKey = {
        keyId: 'key-1',
        userId: 'user-1',
        ...(orgId !== null ? { orgId } : {}),
        scopes: ['anchor:write'],
        rateLimitTier: 'paid' as const,
        keyPrefix: 'arkv_test_',
      } as unknown as express.Request['apiKey'];
      req.apiKey = apiKey;
      next();
    });
  }
  app.use('/v1/contracts', anchorPreSigningRouter);
  return app;
}

const VALID_FINGERPRINT = 'a'.repeat(64);

const VALID_BODY = {
  fingerprint: VALID_FINGERPRINT,
  contract_metadata: {
    title: 'Master Services Agreement',
    counterparty_labels: ['Acme Corp', 'Arkova Inc'],
  },
  signing_workflow_metadata: {
    provider: 'docusign' as const,
    external_envelope_id: 'env-12345',
  },
};

describe('POST /api/v1/contracts/anchor-pre-signing — shape contract (inherited from [Spec])', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default supabase chain: no existing row, insert returns a fresh anchor.
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    insertSingle.mockResolvedValue({
      data: {
        public_id: 'ARK-2026-ABCD1234',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-05-03T22:00:00Z',
      },
      error: null,
    });
    // Default credit gate: allowed (most tests assert success).
    mockDeductOrgCredit.mockResolvedValue({ allowed: true });
  });

  // ─── Auth gate ─────────────────────────────────────────────────────────
  it('401 without API key', async () => {
    const res = await request(makeApp({ withApiKey: false }))
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key/i);
  });

  // ─── Fingerprint validation ────────────────────────────────────────────
  it('400 when fingerprint is missing', async () => {
    const { fingerprint: _, ...body } = VALID_BODY;
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.details.some((d: { path: string }) => d.path === 'fingerprint')).toBe(true);
  });

  it('400 when fingerprint is wrong length', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, fingerprint: 'a'.repeat(63) });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: { path: string }) => d.path === 'fingerprint')).toBe(true);
  });

  it('400 when fingerprint contains non-hex characters', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, fingerprint: 'g'.repeat(64) });
    expect(res.status).toBe(400);
  });

  // ─── Strict mode — unknown fields rejected ────────────────────────────
  it('400 when unknown top-level field is present (strict mode)', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, raw_pdf_bytes: 'not-allowed-per-1.6' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('400 when unknown field nested in contract_metadata (strict mode)', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: {
          ...VALID_BODY.contract_metadata,
          counterparty_emails: ['leak@example.com'],
        },
      });
    expect(res.status).toBe(400);
  });

  // ─── credential_type literal lock ─────────────────────────────────────
  it('400 when credential_type is anything other than CONTRACT_PRESIGNING', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, credential_type: 'DEGREE' });
    expect(res.status).toBe(400);
  });

  // ─── Provider enum lock ───────────────────────────────────────────────
  it('400 when signing provider is not in the enum', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        signing_workflow_metadata: {
          ...VALID_BODY.signing_workflow_metadata,
          provider: 'hellosign',
        },
      });
    expect(res.status).toBe(400);
  });

  // ─── Counterparty bounds ──────────────────────────────────────────────
  it('400 when counterparty_labels is empty', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: { ...VALID_BODY.contract_metadata, counterparty_labels: [] },
      });
    expect(res.status).toBe(400);
  });

  it('400 when counterparty_labels exceeds max', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: {
          ...VALID_BODY.contract_metadata,
          counterparty_labels: Array.from({ length: 21 }, (_, i) => `Party-${i}`),
        },
      });
    expect(res.status).toBe(400);
  });
});

// ─── Real-handler success paths (SCRUM-1631) ─────────────────────────────
describe('POST /api/v1/contracts/anchor-pre-signing — real handler (SCRUM-1631)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    insertSingle.mockResolvedValue({
      data: {
        public_id: 'ARK-2026-ABCD1234',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-05-03T22:00:00Z',
      },
      error: null,
    });
    mockDeductOrgCredit.mockResolvedValue({ allowed: true });
  });

  it('201 with PreSigningAnchorReceipt on fresh fingerprint', async () => {
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      public_id: 'ARK-2026-ABCD1234',
      fingerprint: VALID_FINGERPRINT,
      credential_type: 'CONTRACT_PRESIGNING',
      status: 'PENDING',
      parent_public_id: null,
      contract_metadata: VALID_BODY.contract_metadata,
      signing_workflow_metadata: VALID_BODY.signing_workflow_metadata,
      created_at: '2026-05-03T22:00:00Z',
      record_uri: 'https://example.test/verify/ARK-2026-ABCD1234',
    });
  });

  it('insertPayload pins credential_type=CONTRACT_PRESIGNING + metadata structure', async () => {
    await request(makeApp()).post('/v1/contracts/anchor-pre-signing').send(VALID_BODY);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const payload = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.credential_type).toBe('CONTRACT_PRESIGNING');
    expect(payload.fingerprint).toBe(VALID_FINGERPRINT);
    expect(payload.status).toBe('PENDING');
    // Contract + signing-workflow metadata stored as nested keys inside
    // anchors.metadata jsonb so the verification UI + SCRUM-1624 webhook
    // receiver can read them by key.
    expect(payload.metadata).toEqual({
      contract_metadata: VALID_BODY.contract_metadata,
      signing_workflow_metadata: VALID_BODY.signing_workflow_metadata,
    });
    // filename gets a contract-pre/ prefix so verification UI can render
    // a human-readable handle for an anchor that has no actual file.
    expect(payload.filename).toMatch(/^contract-pre\//);
  });

  it('strips control characters from contract title before building filename', async () => {
    // CodeRabbit major on PR #680: `anchors.filename` has DB-side
    // control-character checks. A title containing \n / \r / etc. would
    // pass Zod's string check but fail the insert AFTER credit deduction.
    await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: {
          ...VALID_BODY.contract_metadata,
          title: 'NDA\n\rwith control\x00chars',
        },
      });
    const payload = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    // \n, \r, and \x00 must all be stripped (replaced with spaces, then trimmed).
    // eslint-disable-next-line no-control-regex
    expect(payload.filename).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(payload.filename).toBe('contract-pre/NDA  with control chars');
  });

  it('falls back to "untitled" when title is entirely control characters', async () => {
    await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: { ...VALID_BODY.contract_metadata, title: '\n\r\t' },
      });
    const payload = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.filename).toBe('contract-pre/untitled');
  });

  it('drops `description` on write (no free-text PII channel)', async () => {
    // CodeRabbit major on PR #680: writing arbitrary prose into
    // anchors.description on a contract endpoint opens a PII channel
    // outside the structured contract metadata. v1 keeps accepting the
    // field for forward-compat but writes null.
    await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        description:
          'Contains the full text of the proposed contract terms which is exactly the kind of thing this endpoint must NOT persist.',
      });
    const payload = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.description).toBeNull();
  });

  it('canonicalizes uppercase fingerprint to lowercase before insert', async () => {
    const upper = 'A'.repeat(64);
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({ ...VALID_BODY, fingerprint: upper });
    expect(res.status).toBe(201);
    const payload = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    // The schema's .transform() must lowercase before the handler reaches
    // the DB insert path — otherwise duplicate idempotency rows split on
    // case alone.
    expect(payload.fingerprint).toBe('a'.repeat(64));
  });

  it.each(['docusign', 'adobe_sign', 'other'] as const)(
    '201 for provider: %s and persists provider in metadata',
    async (provider) => {
      const res = await request(makeApp())
        .post('/v1/contracts/anchor-pre-signing')
        .send({
          ...VALID_BODY,
          signing_workflow_metadata: { ...VALID_BODY.signing_workflow_metadata, provider },
        });
      expect(res.status).toBe(201);
      const payload = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
      const metadata = payload.metadata as { signing_workflow_metadata: { provider: string } };
      expect(metadata.signing_workflow_metadata.provider).toBe(provider);
    },
  );
});

// ─── Idempotency ─────────────────────────────────────────────────────────
describe('POST /api/v1/contracts/anchor-pre-signing — idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeductOrgCredit.mockResolvedValue({ allowed: true });
  });

  it('200 + existing receipt when fingerprint already anchored (with persisted metadata)', async () => {
    // The persisted metadata MUST come back unchanged on idempotent retry —
    // even if the retry's request body has different counterparty_labels or
    // a different envelope id. Otherwise integrators caching the receipt
    // would see fabricated values.
    const persistedContractMetadata = {
      title: 'PERSISTED — Master Services Agreement',
      counterparty_labels: ['PERSISTED Acme Corp', 'PERSISTED Arkova Inc'],
    };
    const persistedSigningMetadata = {
      provider: 'docusign' as const,
      external_envelope_id: 'PERSISTED-env-99',
    };
    selectMaybeSingle.mockResolvedValue({
      data: {
        public_id: 'ARK-2026-EXISTING',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-04-01T00:00:00Z',
        metadata: {
          contract_metadata: persistedContractMetadata,
          signing_workflow_metadata: persistedSigningMetadata,
        },
      },
      error: null,
    });

    // Send DIFFERENT metadata on the retry to prove the response uses the
    // stored values, not the request body.
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send({
        ...VALID_BODY,
        contract_metadata: {
          title: 'RETRY — Different Title',
          counterparty_labels: ['RETRY Other Party'],
        },
        signing_workflow_metadata: {
          provider: 'adobe_sign' as const,
          external_envelope_id: 'RETRY-env-different',
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.public_id).toBe('ARK-2026-EXISTING');
    expect(res.body.created_at).toBe('2026-04-01T00:00:00Z');
    // CRITICAL: returned metadata reflects what was persisted, not the retry.
    expect(res.body.contract_metadata).toEqual(persistedContractMetadata);
    expect(res.body.signing_workflow_metadata).toEqual(persistedSigningMetadata);
    // No insert, no credit charge — idempotent return is the whole point.
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDeductOrgCredit).not.toHaveBeenCalled();
  });

  it('idempotency lookup applies org_id, credential_type, deleted_at filters (no cross-tenant leak)', async () => {
    // CodeRabbit critical on PR #680 — without org_id scoping, Org B can
    // probe whether Org A has anchored a document by sending the SHA, and
    // would receive Org A's anchor receipt verbatim. This test asserts the
    // exact filter set the handler applies on the idempotency lookup.
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    await request(makeApp({ orgId: 'org-1' }))
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);

    // The handler's lookup chain is:
    //   .from('anchors')
    //   .select(...)
    //   .eq('fingerprint', fp)
    //   .eq('credential_type', 'CONTRACT_PRESIGNING')
    //   .is('deleted_at', null)
    //   .eq('org_id', 'org-1')   ← critical filter
    //   .maybeSingle()
    const eqCalls = chainEq.mock.calls.map((c) => [c[0], c[1]]);
    const isCalls = chainIs.mock.calls.map((c) => [c[0], c[1]]);
    expect(eqCalls).toContainEqual(['fingerprint', VALID_FINGERPRINT]);
    expect(eqCalls).toContainEqual(['credential_type', 'CONTRACT_PRESIGNING']);
    expect(eqCalls).toContainEqual(['org_id', 'org-1']);
    expect(isCalls).toContainEqual(['deleted_at', null]);
  });

  it('idempotency lookup uses .is(org_id, null) for keys without orgId (anonymous-by-design)', async () => {
    // Anonymous-by-design API keys (no orgId) must scope to NULL-org
    // rows so they can't see tenant-scoped anchors. Asserts the helper's
    // null branch is reachable.
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    await request(makeApp({ orgId: null }))
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    const isCalls = chainIs.mock.calls.map((c) => [c[0], c[1]]);
    expect(isCalls).toContainEqual(['org_id', null]);
  });

  it('503 when idempotency lookup itself errors (fail-closed)', async () => {
    // CodeRabbit major on PR #680: `maybeSingle()` errors must NOT be
    // treated as cache misses. A transient DB failure should surface 503
    // so the caller retries against a healthy backend rather than
    // spending credits on a broken lookup.
    selectMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'connection reset by peer' },
    });
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('idempotency_lookup_unavailable');
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockDeductOrgCredit).not.toHaveBeenCalled();
  });

  it('500 when stored metadata fails Zod re-parse (defense in depth)', async () => {
    // Should be unreachable in practice (write path is strict-validated),
    // but we surface 500 rather than fabricate a receipt if a future
    // migration corrupts an anchor row's metadata jsonb.
    selectMaybeSingle.mockResolvedValue({
      data: {
        public_id: 'ARK-2026-CORRUPT',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-04-01T00:00:00Z',
        metadata: {
          contract_metadata: { title: '' }, // invalid: title min(1)
          signing_workflow_metadata: { provider: 'docusign' },
        },
      },
      error: null,
    });
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('stored_metadata_invalid');
  });
});

// ─── Org-credit gate ─────────────────────────────────────────────────────
describe('POST /api/v1/contracts/anchor-pre-signing — org credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    insertSingle.mockResolvedValue({
      data: {
        public_id: 'ARK-2026-ABCD1234',
        fingerprint: VALID_FINGERPRINT,
        status: 'PENDING',
        created_at: '2026-05-03T22:00:00Z',
      },
      error: null,
    });
  });

  it('402 insufficient_credits when balance < required', async () => {
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('insufficient_credits');
    expect(res.body.balance).toBe(0);
    expect(res.body.required).toBe(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('503 credit_check_unavailable when credit RPC fails', async () => {
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'rpc_failure',
      message: 'connection reset',
    });
    const res = await request(makeApp())
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('credit_check_unavailable');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('skips credit deduction entirely when API key has no orgId', async () => {
    const res = await request(makeApp({ orgId: null }))
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(mockDeductOrgCredit).not.toHaveBeenCalled();
  });
});

// ─── Direct schema tests (no Express harness) ────────────────────────────
describe('PreSigningAnchorSchema', () => {
  it('parses a minimal valid request', () => {
    const result = PreSigningAnchorSchema.safeParse(VALID_BODY);
    expect(result.success).toBe(true);
  });

  it('strips no fields silently — strict mode means unknown keys fail', () => {
    const result = PreSigningAnchorSchema.safeParse({
      ...VALID_BODY,
      __injected_field__: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  it('accepts effective_date when ISO-8601 with offset', () => {
    const result = PreSigningAnchorSchema.safeParse({
      ...VALID_BODY,
      contract_metadata: {
        ...VALID_BODY.contract_metadata,
        effective_date: '2026-05-03T00:00:00Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects effective_date without offset', () => {
    const result = PreSigningAnchorSchema.safeParse({
      ...VALID_BODY,
      contract_metadata: {
        ...VALID_BODY.contract_metadata,
        effective_date: '2026-05-03',
      },
    });
    expect(result.success).toBe(false);
  });

  it('parses credential_type to CONTRACT_PRESIGNING when omitted (.default lock)', () => {
    const result = PreSigningAnchorSchema.safeParse(VALID_BODY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.credential_type).toBe('CONTRACT_PRESIGNING');
    }
  });

  it('canonicalizes fingerprint to lowercase at parse time (idempotency lock)', () => {
    const upper = 'A'.repeat(64);
    const result = PreSigningAnchorSchema.safeParse({ ...VALID_BODY, fingerprint: upper });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fingerprint).toBe('a'.repeat(64));
    }
  });

  it('canonicalizes mixed-case fingerprint to lowercase', () => {
    const mixed = 'AaBbCcDdEeFf' + '0'.repeat(52);
    const result = PreSigningAnchorSchema.safeParse({ ...VALID_BODY, fingerprint: mixed });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fingerprint).toBe(mixed.toLowerCase());
    }
  });
});

// ─── Router-level scope-gate test (CodeRabbit major from PR #679) ────────
describe('POST /api/v1/contracts/anchor-pre-signing — scope gate', () => {
  it('403 when API key lacks anchor:write scope', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { apiKey?: unknown }).apiKey = {
        keyId: 'key-1',
        userId: 'user-1',
        orgId: 'org-1',
        scopes: ['verify'], // missing anchor:write
        rateLimitTier: 'paid',
        keyPrefix: 'arkv_test_',
      };
      next();
    });
    app.use('/v1/contracts', requireScope('anchor:write'), anchorPreSigningRouter);

    const res = await request(app)
      .post('/v1/contracts/anchor-pre-signing')
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required).toBe('anchor:write');
  });
});
