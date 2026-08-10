/**
 * Org-scoped request-field policy — unit tests (DPA Schedule 1 / clause 4.6).
 *
 * The control these tests pin exists because a data-processing agreement can
 * oblige Arkova to REJECT a field independently of the counterparty agreeing
 * to stop sending it. Two properties therefore matter more than usual:
 *
 *   1. DEFAULT PERMISSIVE. An org with no policy row must be byte-for-byte
 *      unaffected — the 24,907 LEGAL anchors already in prod (24,727 of them
 *      carrying a description) were created through this exact code path.
 *   2. REJECT, NEVER SILENTLY DROP. A dropped field looks identical to a
 *      compliant client and is exactly the "silent success" failure this
 *      repo has shipped before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockMaybeSingle = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());
// SCRUM-1258: the break-glass is read from the Zod-validated config, not from
// process.env, so it is driven here rather than by mutating the environment.
const mockConfig = vi.hoisted(() => ({ disableOrgFieldPolicy: false }));

vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('./logger.js', () => ({ logger: mockLogger }));
vi.mock('./db.js', () => ({
  db: {
    from: mockFrom,
  },
}));

import {
  ORG_FIELD_POLICY_REJECTED_ERROR,
  ORG_FIELD_POLICY_UNAVAILABLE_ERROR,
  clearOrgFieldPolicyCache,
  enforceOrgFieldPolicy,
  findProhibitedFields,
  normalizeFieldName,
} from './orgFieldPolicy.js';

/** Minimal express Response double capturing status/type/json. */
function makeRes() {
  const captured: { status: number | null; body: unknown; contentType: string | null } = {
    status: null,
    body: null,
    contentType: null,
  };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    type(t: string) {
      captured.contentType = t;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res: res as unknown as import('express').Response, captured };
}

/** Wire db.from('organization_field_policies') → .select().eq().maybeSingle(). */
function stubPolicyRead(result: { data?: unknown; error?: unknown }) {
  mockMaybeSingle.mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'organization_field_policies') {
      throw new Error(`unexpected table read: ${table}`);
    }
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: mockMaybeSingle,
    };
    return chain;
  });
}

const HAKI_POLICY_ROW = {
  org_id: 'org-haki',
  disallowed_fields: ['description'],
  enabled: true,
  policy_reason: 'DPA Schedule 1 permits fingerprint, matter reference and credential type only.',
  contract_reference: 'HakiChain DPA Schedule 1 / clause 4.6',
};

describe('normalizeFieldName', () => {
  it('lower-cases and trims', () => {
    expect(normalizeFieldName('  Description ')).toBe('description');
    expect(normalizeFieldName('DESCRIPTION')).toBe('description');
  });

  it('folds hyphen/space separators onto underscore', () => {
    expect(normalizeFieldName('Matter-Description')).toBe('matter_description');
    expect(normalizeFieldName('matter description')).toBe('matter_description');
  });
});

describe('findProhibitedFields', () => {
  const disallowed = new Set(['description']);

  it('returns no hits for a compliant payload', () => {
    const out = findProhibitedFields(
      { fingerprint: 'a'.repeat(64), credential_type: 'LEGAL', matter_or_case_ref: 'HK-1' },
      disallowed,
    );
    expect(out.hits).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('finds a top-level prohibited field', () => {
    const out = findProhibitedFields({ fingerprint: 'x', description: 'free text' }, disallowed);
    expect(out.hits).toEqual([{ path: 'description', field: 'description' }]);
  });

  it('finds a differently-cased key (case is not a bypass)', () => {
    const out = findProhibitedFields({ Description: 'free text' }, disallowed);
    expect(out.hits.map((h) => h.field)).toEqual(['description']);
    expect(out.hits[0].path).toBe('Description');
  });

  it('finds a whitespace-padded key', () => {
    const out = findProhibitedFields({ ' description ': 'free text' }, disallowed);
    expect(out.hits.map((h) => h.field)).toEqual(['description']);
  });

  it('finds a hyphenated alias of the prohibited name', () => {
    const out = findProhibitedFields({ 'Matter-Description': 'x' }, new Set(['matter_description']));
    expect(out.hits.map((h) => h.field)).toEqual(['matter_description']);
  });

  it('finds the field nested inside metadata (the real bypass)', () => {
    const out = findProhibitedFields(
      { fingerprint: 'x', metadata: { description: 'free text' } },
      disallowed,
    );
    expect(out.hits).toEqual([{ path: 'metadata.description', field: 'description' }]);
  });

  it('finds the field nested several levels deep', () => {
    const out = findProhibitedFields(
      { metadata: { custom: { nested: { description: 'free text' } } } },
      disallowed,
    );
    expect(out.hits[0].path).toBe('metadata.custom.nested.description');
  });

  it('finds the field inside array elements and reports the index', () => {
    const out = findProhibitedFields(
      { anchors: [{ fingerprint: 'a' }, { fingerprint: 'b', description: 'free text' }] },
      disallowed,
    );
    expect(out.hits).toEqual([{ path: 'anchors.1.description', field: 'description' }]);
  });

  it('does not match a merely similar key', () => {
    const out = findProhibitedFields({ document_type: 'contract', descriptor: 'x' }, disallowed);
    expect(out.hits).toEqual([]);
  });

  it('matches on key PRESENCE even when the value is null or empty', () => {
    expect(findProhibitedFields({ description: null }, disallowed).hits).toHaveLength(1);
    expect(findProhibitedFields({ description: '' }, disallowed).hits).toHaveLength(1);
  });

  it('an empty policy set never matches anything', () => {
    const out = findProhibitedFields({ description: 'x', anything: 1 }, new Set<string>());
    expect(out.hits).toEqual([]);
  });

  it('flags truncation rather than silently stopping when the payload exceeds the walk budget', () => {
    // Build a payload deeper than the depth cap with the prohibited key at the bottom.
    let deep: Record<string, unknown> = { description: 'hidden at the bottom' };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    const out = findProhibitedFields(deep, disallowed);
    expect(out.truncated).toBe(true);
  });
});

describe('enforceOrgFieldPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOrgFieldPolicyCache();
    mockConfig.disableOrgFieldPolicy = false;
  });

  afterEach(() => {
    mockConfig.disableOrgFieldPolicy = false;
  });

  it('allows an org with NO policy row (regression guard for existing orgs)', async () => {
    stubPolicyRead({ data: null });
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-1',
      body: { fingerprint: 'a'.repeat(64), description: 'perfectly fine here' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(true);
    expect(captured.status).toBeNull();
  });

  it('allows when orgId is null (API key with no org)', async () => {
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: null,
      body: { description: 'x' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(true);
    expect(captured.status).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('allows when the policy row exists but is disabled', async () => {
    stubPolicyRead({ data: { ...HAKI_POLICY_ROW, enabled: false } });
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { description: 'x' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(true);
    expect(captured.status).toBeNull();
  });

  it('allows when disallowed_fields is empty or null', async () => {
    stubPolicyRead({ data: { ...HAKI_POLICY_ROW, disallowed_fields: [] } });
    const { res } = makeRes();
    expect(
      await enforceOrgFieldPolicy({ orgId: 'org-haki', body: { description: 'x' }, res, scope: 's' }),
    ).toBe(true);

    clearOrgFieldPolicyCache();
    stubPolicyRead({ data: { ...HAKI_POLICY_ROW, disallowed_fields: null } });
    const second = makeRes();
    expect(
      await enforceOrgFieldPolicy({
        orgId: 'org-haki',
        body: { description: 'x' },
        res: second.res,
        scope: 's',
      }),
    ).toBe(true);
  });

  it('REJECTS with 400 + per-field detail for a configured org', async () => {
    stubPolicyRead({ data: HAKI_POLICY_ROW });
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { fingerprint: 'a'.repeat(64), credential_type: 'LEGAL', description: 'client name' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(false);
    expect(captured.status).toBe(400);
    const body = captured.body as {
      error: string;
      message: string;
      details: Array<{ path: string; code: string; message: string }>;
      policy_reason?: string;
    };
    expect(body.error).toBe(ORG_FIELD_POLICY_REJECTED_ERROR);
    expect(body.details).toEqual([
      expect.objectContaining({ path: 'description', code: ORG_FIELD_POLICY_REJECTED_ERROR }),
    ]);
    expect(body.details[0].message).toContain('description');
    expect(body.policy_reason).toBe(HAKI_POLICY_ROW.policy_reason);
  });

  it('never echoes the rejected VALUE back to the caller or into the logs', async () => {
    stubPolicyRead({ data: HAKI_POLICY_ROW });
    const secret = 'Wanjiku-v-Republic-confidential-matter-note';
    const { res, captured } = makeRes();
    await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { description: secret },
      res,
      scope: 'anchor-submit',
    });
    expect(JSON.stringify(captured.body)).not.toContain(secret);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(secret);
  });

  it('rejects the nested-metadata bypass', async () => {
    stubPolicyRead({ data: HAKI_POLICY_ROW });
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { fingerprint: 'a'.repeat(64), metadata: { description: 'client name' } },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(false);
    expect(captured.status).toBe(400);
    expect((captured.body as { details: Array<{ path: string }> }).details[0].path).toBe(
      'metadata.description',
    );
  });

  it('rejects an un-walkable (over-budget) payload rather than passing it through', async () => {
    stubPolicyRead({ data: HAKI_POLICY_ROW });
    let deep: Record<string, unknown> = { ok: true };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: deep,
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(false);
    expect(captured.status).toBe(400);
  });

  it('is PERMISSIVE when the policy table is not deployed (PGRST205)', async () => {
    stubPolicyRead({ error: { code: 'PGRST205', message: 'could not find the table' } });
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { description: 'x' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(true);
    expect(captured.status).toBeNull();
  });

  it('FAILS CLOSED with 503 on an unexplained read failure with a cold cache', async () => {
    stubPolicyRead({ error: { code: '57014', message: 'statement timeout' } });
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { description: 'x' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(false);
    expect(captured.status).toBe(503);
    expect((captured.body as { error: string }).error).toBe(ORG_FIELD_POLICY_UNAVAILABLE_ERROR);
  });

  it('falls back to the last known good policy when a later read fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now();
      stubPolicyRead({ data: HAKI_POLICY_ROW });
      const first = makeRes();
      expect(
        await enforceOrgFieldPolicy({
          orgId: 'org-haki',
          body: { fingerprint: 'a' },
          res: first.res,
          scope: 's',
        }),
      ).toBe(true);

      // Expire the fresh-TTL, then fail the read: the STALE policy must still reject.
      vi.setSystemTime(t0 + 5 * 60_000);
      stubPolicyRead({ error: { code: '57014', message: 'statement timeout' } });
      const second = makeRes();
      const ok = await enforceOrgFieldPolicy({
        orgId: 'org-haki',
        body: { description: 'x' },
        res: second.res,
        scope: 's',
      });
      expect(ok).toBe(false);
      expect(second.captured.status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches the policy so repeat requests do not re-read the table', async () => {
    stubPolicyRead({ data: HAKI_POLICY_ROW });
    for (let i = 0; i < 5; i++) {
      const { res } = makeRes();
      await enforceOrgFieldPolicy({ orgId: 'org-haki', body: { fingerprint: 'a' }, res, scope: 's' });
    }
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('break-glass DISABLE_ORG_FIELD_POLICY=true suppresses enforcement entirely', async () => {
    stubPolicyRead({ data: HAKI_POLICY_ROW });
    mockConfig.disableOrgFieldPolicy = true;
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { description: 'x' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(true);
    expect(captured.status).toBeNull();
    // Break-glass must be loud — it voids the contractual control.
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('a non-true flag value leaves the control ON (a typo must not silently disable it)', async () => {
    // config.disableOrgFieldPolicy is produced by `boolFlag`, whose preprocess
    // is `v === 'true' || v === true`. So DISABLE_ORG_FIELD_POLICY='yes' lands
    // here as `false` — coerced, not rejected — and enforcement stays on. This
    // pins the fail-safe DIRECTION of that coercion, which is the property that
    // matters for a kill-switch on a contractual control.
    stubPolicyRead({ data: HAKI_POLICY_ROW });
    mockConfig.disableOrgFieldPolicy = false;
    const { res, captured } = makeRes();
    const ok = await enforceOrgFieldPolicy({
      orgId: 'org-haki',
      body: { description: 'x' },
      res,
      scope: 'anchor-submit',
    });
    expect(ok).toBe(false);
    expect(captured.status).toBe(400);
  });
});
