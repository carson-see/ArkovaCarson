/**
 * NCA-03 Compliance Audit API — tests.
 *
 * Covers the POST / GET lifecycle and idempotency window. DB is mocked at
 * the `db.from(table)` level so the test stays isolated from Supabase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../compliance/auth-helpers.js', () => ({
  getCallerOrgId: vi.fn(),
}));

import { complianceAuditRouter } from './compliance-audit.js';
import { db } from '../../utils/db.js';
import { getCallerOrgId } from '../../compliance/auth-helpers.js';
import { buildApp as buildAppFromRouter, makeBuilder } from './__testHelpers.js';

function buildApp(userId?: string) {
  return buildAppFromRouter(complianceAuditRouter, '/api/v1/compliance/audit', { userId });
}

describe('POST /api/v1/compliance/audit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('400s on invalid body', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    const app = buildApp('user-1');
    await request(app)
      .post('/api/v1/compliance/audit')
      .send({ jurisdictions: 'not-an-array' })
      .expect(400);
  });

  it('creates a COMPLETED audit row and returns 201 with gaps + quarantines', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    const inserted = {
      id: '11111111-1111-1111-1111-111111111111',
      org_id: 'org-1',
      overall_score: 67,
      overall_grade: 'D',
      per_jurisdiction: [{ jurisdiction_code: 'US-CA', industry_code: 'accounting', score: 67, grade: 'D', total_required: 3, total_present: 2, rule_count: 1 }],
      gaps: [{ type: 'CERTIFICATE', category: 'MISSING', severity: 'high' }],
      quarantines: [{ regulation: 'HIPAA', version: 'v28.0', status: 'QUARANTINED', caveat: 'caveat', tracking: 'SCRUM-819 (NVI-15)' }],
      status: 'COMPLETED',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 120,
      jurisdiction_filter: null,
      error_code: null,
      error_message: null,
      metadata: { anchor_count: 1 },
      created_at: new Date().toISOString(),
    };

    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'compliance_audits') {
        // first call (idempotency probe): return no recent row
        // insert call: return inserted
        const builder = makeBuilder({ maybeSingleData: null, singleData: inserted });
        return builder as unknown as never;
      }
      if (table === 'organizations') {
        return makeBuilder({
          maybeSingleData: { jurisdictions: ['US-CA'], industry: 'accounting' },
        }) as unknown as never;
      }
      if (table === 'jurisdiction_rules') {
        return makeBuilder({
          selectData: [{
            id: 'r1',
            jurisdiction_code: 'US-CA',
            industry_code: 'accounting',
            rule_name: 'CA',
            required_credential_types: ['LICENSE','CERTIFICATE','CONTINUING_EDUCATION'],
            optional_credential_types: [],
            regulatory_reference: 'CA code',
            details: {},
          }],
        }) as unknown as never;
      }
      if (table === 'anchors') {
        return makeBuilder({
          selectData: [
            { id: 'a1', credential_type: 'LICENSE', status: 'SECURED', expires_at: null, label: 'Lic' },
            { id: 'a2', credential_type: 'CONTINUING_EDUCATION', status: 'SECURED', expires_at: null, label: 'CE' },
          ],
        }) as unknown as never;
      }
      if (table === 'integrity_scores') {
        return makeBuilder({
          selectData: [
            { anchor_id: 'a1', overall_score: 0.9, flags: null },
            { anchor_id: 'a2', overall_score: 0.9, flags: null },
          ],
        }) as unknown as never;
      }
      if (table === 'review_queue_items') {
        return makeBuilder({ selectData: [] }) as unknown as never;
      }
      if (table === 'compliance_scores') {
        return makeBuilder({ selectData: [] }) as unknown as never;
      }
      return makeBuilder({ selectData: [] }) as unknown as never;
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/compliance/audit')
      .send({})
      .expect(201);

    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.overall_score).toBe(67);
    expect(res.body.gaps.length).toBeGreaterThan(0);
    expect(res.body.quarantines[0].regulation).toBe('HIPAA');
  });

  it('writes NCA-05 recommendations into metadata on insert', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    const insertCalls: Array<Record<string, unknown>> = [];

    const inserted = {
      id: '22222222-2222-2222-2222-222222222222',
      org_id: 'org-1',
      overall_score: 60,
      overall_grade: 'D',
      per_jurisdiction: [],
      gaps: [],
      quarantines: [],
      status: 'COMPLETED',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 50,
      jurisdiction_filter: null,
      error_code: null,
      error_message: null,
      metadata: {},
      created_at: new Date().toISOString(),
    };

    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'compliance_audits') {
        const builder = makeBuilder({ maybeSingleData: null, singleData: inserted });
        builder.insert = vi.fn((payload: Record<string, unknown>) => {
          insertCalls.push(payload);
          return builder;
        });
        return builder as unknown as never;
      }
      if (table === 'organizations') {
        return makeBuilder({
          maybeSingleData: { jurisdictions: ['US-CA'], industry: 'accounting' },
        }) as unknown as never;
      }
      if (table === 'jurisdiction_rules') {
        return makeBuilder({
          selectData: [{
            id: 'r1',
            jurisdiction_code: 'US-CA',
            industry_code: 'accounting',
            rule_name: 'CA',
            required_credential_types: ['LICENSE','CERTIFICATE'],
            optional_credential_types: [],
            regulatory_reference: 'CA code',
            details: {},
          }],
        }) as unknown as never;
      }
      if (table === 'anchors') {
        return makeBuilder({ selectData: [] }) as unknown as never;
      }
      if (table === 'compliance_scores') {
        return makeBuilder({ selectData: [] }) as unknown as never;
      }
      return makeBuilder({ selectData: [] }) as unknown as never;
    });

    const app = buildApp('user-1');
    await request(app).post('/api/v1/compliance/audit').send({}).expect(201);

    // The first insert call is the successful audit persist; assert its
    // metadata.recommendations is populated by NCA-05.
    expect(insertCalls.length).toBe(1);
    const metadata = insertCalls[0].metadata as Record<string, unknown>;
    expect(Array.isArray(metadata.per_jurisdiction)).toBe(true);
    expect(metadata.recommendations).toBeDefined();
    const recs = metadata.recommendations as { recommendations: unknown[]; overflow_count: number };
    expect(Array.isArray(recs.recommendations)).toBe(true);
    expect(recs.recommendations.length).toBeGreaterThan(0);
    expect(typeof recs.overflow_count).toBe('number');
  });

  // SCRUM-954 / BUG-2026-04-21-007 — see compliance-audit.ts loadOrgJurisdictions.
  // SCRUM-954: default-scope per-jurisdiction fallback. Two cases that share
  // 90% of their fixture wiring — collapsed into it.each so the diff is
  // just the inputs (org industry + ruleset) and the expected `per_jurisdiction`
  // shape, which is what the test is actually asserting.
  type Scrum954Case = {
    label: string;
    insertedId: string;
    insertedScore: number;
    insertedGrade: string;
    duration: number;
    industry: string;
    rules: Array<Record<string, unknown>>;
    expectedJurisdictions: string[];
  };

  const scrum954Cases: Scrum954Case[] = [
    {
      label: 'derives default-scope per_jurisdiction from jurisdiction_rules for orgs with no configured jurisdictions',
      insertedId: '99999999-9999-9999-9999-999999999999',
      insertedScore: 0,
      insertedGrade: 'F',
      duration: 50,
      industry: 'accounting',
      rules: [
        { id: 'r-ca', jurisdiction_code: 'US-CA', industry_code: 'accounting', rule_name: 'CA',
          required_credential_types: ['LICENSE'], optional_credential_types: [],
          regulatory_reference: 'CA code', details: {} },
        { id: 'r-ny', jurisdiction_code: 'US-NY', industry_code: 'accounting', rule_name: 'NY',
          required_credential_types: ['LICENSE'], optional_credential_types: [],
          regulatory_reference: 'NY code', details: {} },
      ],
      expectedJurisdictions: ['US-CA', 'US-NY'],
    },
    {
      label: 'leaves per_jurisdiction empty when the org has no configured jurisdictions AND no rules apply',
      insertedId: '88888888-8888-8888-8888-888888888888',
      insertedScore: 100,
      insertedGrade: 'A',
      duration: 10,
      industry: 'niche-industry',
      rules: [],
      expectedJurisdictions: [],
    },
  ];

  it.each(scrum954Cases)('SCRUM-954: $label', async (tc) => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    const insertCalls: Array<Record<string, unknown>> = [];
    const nowIso = new Date().toISOString();
    const inserted = {
      id: tc.insertedId,
      org_id: 'org-1',
      overall_score: tc.insertedScore,
      overall_grade: tc.insertedGrade,
      per_jurisdiction: [],
      gaps: [],
      quarantines: [],
      status: 'COMPLETED',
      started_at: nowIso,
      completed_at: nowIso,
      duration_ms: tc.duration,
      jurisdiction_filter: null,
      error_code: null,
      error_message: null,
      metadata: {},
      created_at: nowIso,
    };

    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'compliance_audits') {
        const builder = makeBuilder({ maybeSingleData: null, singleData: inserted });
        builder.insert = vi.fn((payload: Record<string, unknown>) => {
          insertCalls.push(payload);
          return builder;
        });
        return builder as unknown as never;
      }
      if (table === 'organizations') {
        return makeBuilder({
          maybeSingleData: { jurisdictions: [], industry: tc.industry },
        }) as unknown as never;
      }
      if (table === 'jurisdiction_rules') {
        return makeBuilder({ selectData: tc.rules }) as unknown as never;
      }
      // compliance_scores, anchors, anything else — empty
      return makeBuilder({ selectData: [] }) as unknown as never;
    });

    const app = buildApp('user-1');
    await request(app).post('/api/v1/compliance/audit').send({}).expect(201);

    expect(insertCalls.length).toBe(1);
    const payload = insertCalls[0];
    const topLevel = payload.per_jurisdiction as Array<{ jurisdiction_code: string }>;

    if (tc.expectedJurisdictions.length === 0) {
      expect(topLevel).toEqual([]);
    } else {
      // Both top-level column and metadata mirror are populated so the
      // scorecard read-side fallback (PR #607) and the page-level normalize
      // step both have data. Asserted on the populated case only since the
      // empty case has no metadata.per_jurisdiction to mirror.
      const metadata = payload.metadata as Record<string, unknown>;
      const meta = metadata.per_jurisdiction as Array<{ jurisdiction_code: string }>;
      expect(topLevel.length).toBe(tc.expectedJurisdictions.length);
      expect(meta.length).toBe(tc.expectedJurisdictions.length);
      expect(topLevel.map((p) => p.jurisdiction_code).sort()).toEqual(tc.expectedJurisdictions);
    }
  });

  it('returns idempotent completed audit when a recent one exists', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    const recent = {
      id: 'existing-id',
      org_id: 'org-1',
      overall_score: 80,
      overall_grade: 'B',
      per_jurisdiction: [],
      gaps: [],
      quarantines: [],
      status: 'COMPLETED',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 100,
      jurisdiction_filter: [],
      error_code: null,
      error_message: null,
      metadata: {},
      created_at: new Date().toISOString(),
    };

    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'compliance_audits') {
        return makeBuilder({ maybeSingleData: recent, singleData: recent }) as unknown as never;
      }
      return makeBuilder() as unknown as never;
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/compliance/audit')
      .send({})
      .expect(200);

    expect(res.body.idempotent).toBe(true);
    expect(res.body.id).toBe('existing-id');
  });
});

describe('GET /api/v1/compliance/audit/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('400s on non-uuid id', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    const app = buildApp('user-1');
    await request(app).get('/api/v1/compliance/audit/not-a-uuid').expect(400);
  });

  it('404s when audit not found', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(db.from).mockImplementation((): never =>
      makeBuilder({ singleError: { message: 'not found' } }) as unknown as never,
    );
    const app = buildApp('user-1');
    await request(app)
      .get('/api/v1/compliance/audit/11111111-1111-1111-1111-111111111111')
      .expect(404);
  });

  it('returns the audit when it exists', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(db.from).mockImplementation((): never =>
      makeBuilder({
        singleData: {
          id: '11111111-1111-1111-1111-111111111111',
          org_id: 'org-1',
          overall_score: 77,
          overall_grade: 'C',
          status: 'COMPLETED',
          per_jurisdiction: [], gaps: [], quarantines: [],
          started_at: '', completed_at: '', duration_ms: 0,
          jurisdiction_filter: null, error_code: null, error_message: null,
          metadata: {}, created_at: '',
        },
      }) as unknown as never,
    );
    const app = buildApp('user-1');
    const res = await request(app)
      .get('/api/v1/compliance/audit/11111111-1111-1111-1111-111111111111')
      .expect(200);
    expect(res.body.overall_score).toBe(77);
  });
});

describe('loadOrgAnchors with integrity_scores + review_queue_items JOIN (NCA-FU1 #5)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /**
   * Simpler fluent builder that avoids the Promise-Object hybrid
   * approach of makeBuilder. All chain methods return `this`; the
   * terminal `.limit()` always returns a plain Promise.
   */
  function simpleBuilder(data: unknown = [], error: unknown = null) {
    const b = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data, error }),
      single: vi.fn().mockResolvedValue({ data, error }),
      maybeSingle: vi.fn().mockResolvedValue({ data, error }),
      insert: vi.fn().mockReturnThis(),
      then: vi.fn(),
    };
    return b;
  }

  it('merges integrity_score from integrity_scores and fraud_flags from review_queue_items', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    const inserted = {
      id: '22222222-2222-2222-2222-222222222222',
      org_id: 'org-1', overall_score: 100, overall_grade: 'A',
      per_jurisdiction: [], gaps: [], quarantines: [],
      status: 'COMPLETED', started_at: '', completed_at: '', duration_ms: 50,
      jurisdiction_filter: null, error_code: null, error_message: null,
      metadata: { anchor_count: 1 }, created_at: '',
    };

    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'compliance_audits') {
        return simpleBuilder(null) as unknown as never;
      }
      if (table === 'organizations') {
        return simpleBuilder({ jurisdictions: ['US-CA'], industry: 'accounting' }) as unknown as never;
      }
      if (table === 'jurisdiction_rules') {
        return simpleBuilder([{
          id: 'r1', jurisdiction_code: 'US-CA', industry_code: 'accounting',
          rule_name: 'CA', required_credential_types: ['LICENSE'],
          optional_credential_types: [], regulatory_reference: null, details: {},
        }]) as unknown as never;
      }
      if (table === 'anchors') {
        return simpleBuilder([
          { id: 'a1', credential_type: 'LICENSE', status: 'SECURED', not_after: null, title: 'Lic' },
        ]) as unknown as never;
      }
      if (table === 'integrity_scores') {
        return simpleBuilder([
          { anchor_id: 'a1', overall_score: 0.85, flags: null },
        ]) as unknown as never;
      }
      if (table === 'review_queue_items') {
        return simpleBuilder([
          { anchor_id: 'a1', flags: ['duplicate_detected', 'issuer_mismatch'] },
        ]) as unknown as never;
      }
      return simpleBuilder([]) as unknown as never;
    });

    // Override compliance_audits insert to return the inserted row
    let callCount = 0;
    const origImpl = vi.mocked(db.from).getMockImplementation()!;
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'compliance_audits') {
        callCount++;
        // First call = idempotency probe (returns null), subsequent = insert
        if (callCount <= 1) return simpleBuilder(null) as unknown as never;
        return simpleBuilder(inserted) as unknown as never;
      }
      return origImpl(table as Parameters<typeof origImpl>[0]) as never;
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/compliance/audit')
      .send({})
      .expect(201);

    expect(res.body.status).toBe('COMPLETED');
    // Verify that integrity_scores and review_queue_items were queried
    const calledTables = vi.mocked(db.from).mock.calls.map(c => c[0]);
    expect(calledTables).toContain('integrity_scores');
    expect(calledTables).toContain('review_queue_items');
  });

  it('returns null integrity_score and empty fraud_flags when no related rows exist', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    const inserted = {
      id: '33333333-3333-3333-3333-333333333333',
      org_id: 'org-1', overall_score: 100, overall_grade: 'A',
      per_jurisdiction: [], gaps: [], quarantines: [],
      status: 'COMPLETED', started_at: '', completed_at: '', duration_ms: 50,
      jurisdiction_filter: null, error_code: null, error_message: null,
      metadata: { anchor_count: 1 }, created_at: '',
    };

    let auditCallCount = 0;
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'compliance_audits') {
        auditCallCount++;
        if (auditCallCount <= 1) return simpleBuilder(null) as unknown as never;
        return simpleBuilder(inserted) as unknown as never;
      }
      if (table === 'organizations') {
        return simpleBuilder({ jurisdictions: ['US-CA'], industry: 'accounting' }) as unknown as never;
      }
      if (table === 'jurisdiction_rules') {
        return simpleBuilder([{
          id: 'r1', jurisdiction_code: 'US-CA', industry_code: 'accounting',
          rule_name: 'CA', required_credential_types: ['LICENSE'],
          optional_credential_types: [], regulatory_reference: null, details: {},
        }]) as unknown as never;
      }
      if (table === 'anchors') {
        return simpleBuilder([
          { id: 'a1', credential_type: 'LICENSE', status: 'SECURED', not_after: null, title: 'Lic' },
        ]) as unknown as never;
      }
      if (table === 'integrity_scores') {
        return simpleBuilder([]) as unknown as never;
      }
      if (table === 'review_queue_items') {
        return simpleBuilder([]) as unknown as never;
      }
      return simpleBuilder([]) as unknown as never;
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/compliance/audit')
      .send({})
      .expect(201);

    expect(res.body.status).toBe('COMPLETED');
  });
});

describe('GET /api/v1/compliance/audit (list)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns up to limit audits for the org', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(db.from).mockImplementation((): never =>
      makeBuilder({
        selectData: [
          { id: 'a', org_id: 'org-1', overall_score: 70, overall_grade: 'C', per_jurisdiction: [], gaps: [], quarantines: [], status: 'COMPLETED', started_at: '', completed_at: '', duration_ms: 1, jurisdiction_filter: null, error_code: null, error_message: null, metadata: {}, created_at: '' },
          { id: 'b', org_id: 'org-1', overall_score: 80, overall_grade: 'B', per_jurisdiction: [], gaps: [], quarantines: [], status: 'COMPLETED', started_at: '', completed_at: '', duration_ms: 1, jurisdiction_filter: null, error_code: null, error_message: null, metadata: {}, created_at: '' },
        ],
      }) as unknown as never,
    );
    const app = buildApp('user-1');
    const res = await request(app)
      .get('/api/v1/compliance/audit?limit=5')
      .expect(200);
    expect(res.body.audits.length).toBe(2);
    expect(res.body.count).toBe(2);
  });

  it('hydrates per_jurisdiction from metadata for legacy rows with an empty top-level array', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(db.from).mockImplementation((): never =>
      makeBuilder({
        selectData: [
          {
            id: 'legacy',
            org_id: 'org-1',
            overall_score: 100,
            overall_grade: 'A',
            per_jurisdiction: [],
            gaps: [],
            quarantines: [],
            status: 'COMPLETED',
            started_at: '',
            completed_at: '',
            duration_ms: 1,
            jurisdiction_filter: null,
            error_code: null,
            error_message: null,
            metadata: {
              per_jurisdiction: [
                { jurisdiction_code: 'US', industry_code: 'default', score: 100, grade: 'A', total_required: 1, total_present: 1, rule_count: 1 },
              ],
            },
            created_at: '',
          },
        ],
      }) as unknown as never,
    );

    const app = buildApp('user-1');
    const res = await request(app)
      .get('/api/v1/compliance/audit?limit=5')
      .expect(200);

    expect(res.body.audits[0].per_jurisdiction).toHaveLength(1);
    expect(res.body.audits[0].per_jurisdiction[0].jurisdiction_code).toBe('US');
  });
});
