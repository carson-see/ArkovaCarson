/**
 * NCA-03 Compliance Audit API — tests.
 *
 * Covers the POST / GET lifecycle and idempotency window. DB is mocked at
 * the `db.from(table)` level so the test stays isolated from Supabase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
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

function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/compliance/audit', complianceAuditRouter);
  return app;
}

interface QueryBuilder {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
}

/**
 * Fluent mock that satisfies every chain the audit route uses.
 * `state` drives the terminal method return values.
 */
function makeBuilder(state: {
  selectData?: unknown;
  selectError?: unknown;
  insertData?: unknown;
  insertError?: unknown;
  singleData?: unknown;
  singleError?: unknown;
  maybeSingleData?: unknown;
} = {}): QueryBuilder {
  const builder = {} as QueryBuilder;
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.insert = vi.fn(() => builder);
  builder.eq = vi.fn(chain);
  builder.in = vi.fn(chain);
  builder.gte = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.limit = vi.fn(() => {
    // Default terminal for GET list endpoint
    return Object.assign(Promise.resolve({
      data: (state.selectData ?? []) as unknown,
      error: state.selectError ?? null,
    }), builder);
  });
  builder.single = vi.fn(() => Promise.resolve({
    data: state.singleData ?? null,
    error: state.singleError ?? null,
  }));
  builder.maybeSingle = vi.fn(() => Promise.resolve({
    data: state.maybeSingleData ?? null,
    error: null,
  }));
  return builder;
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
            { id: 'a1', credential_type: 'LICENSE', status: 'SECURED', not_after: null, title: 'Lic' },
            { id: 'a2', credential_type: 'CONTINUING_EDUCATION', status: 'SECURED', not_after: null, title: 'CE' },
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
});
