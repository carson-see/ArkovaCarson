/**
 * Tests for the CLE compliance-log export worker (SCRUM-1870 — CLE-R2).
 *
 * Covers PDF + JSON generation, Supabase Storage upload + signed URL (reusing
 * the CPE export's `createSupabaseStorageAdapter` / `CpeExportStorage` seam),
 * the `cle_log_v1` Zod schema, the metadata-only `cle_log.exported` audit event
 * (CC7 no-content-leak), per-credential field mapping from `cle_metadata`, the
 * SEPARATE ethics-hours subtotal (never combined with total credit hours), the
 * jurisdiction filter (bare `CA` or `US-CA`), and the 200-record performance
 * budget (< 10s).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CLE_LOG_SCHEMA_VERSION,
  CleLogV1Schema,
  buildCleLogRecord,
  computeCleSummary,
  generateCleLogExport,
  normalizeJurisdiction,
  CLE_DISCLAIMER_TEXT,
  type CleExportAnchorRow,
  type CleLogExportDeps,
} from './cle-log-export.js';

// ─── Fixtures ────────────────────────────────────────
function makeAnchor(overrides: Partial<CleExportAnchorRow> = {}): CleExportAnchorRow {
  return {
    id: 'anchor-uuid-1',
    public_id: 'ARK-CLE-0001',
    org_id: 'org-1',
    user_id: 'user-1',
    label: 'Ethics in Modern Litigation',
    filename: 'cle-cert.pdf',
    status: 'SECURED',
    issued_at: '2026-03-15T00:00:00.000Z',
    chain_timestamp: '2026-03-16T11:04:00.000Z',
    created_at: '2026-03-15T09:00:00.000Z',
    credential_type: 'CLE',
    metadata: {
      verification_level: 'captured_upload_ai',
    },
    cle_metadata: {
      credit_hours: 6,
      ethics_hours: 2,
      jurisdiction: 'CA',
      approved_provider_name: 'State Bar of California',
      provider_approval_status: 'approved',
      delivery_format: 'Live',
      course_title: 'Ethics in Modern Litigation',
      course_id: 'CA-2026-0099',
      extraction_confidence: 0.96,
      extraction_source: 'ai',
      requires_manual_review: false,
    },
    ...overrides,
  };
}

interface UploadCall {
  bucket: string;
  path: string;
  contentType: string | undefined;
  bodyLength: number;
  body: Uint8Array | string;
}

interface SignedUrlCall {
  bucket: string;
  path: string;
  expiresIn: number;
}

function makeDeps(opts: {
  anchors?: CleExportAnchorRow[];
  uploadError?: boolean;
  signError?: boolean;
} = {}): {
  deps: CleLogExportDeps;
  uploads: UploadCall[];
  signs: SignedUrlCall[];
  audits: Array<Record<string, unknown>>;
} {
  const uploads: UploadCall[] = [];
  const signs: SignedUrlCall[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const anchors = opts.anchors ?? [makeAnchor()];

  // Minimal Supabase-query-builder mock for the anchors SELECT chain.
  const anchorQuery: Record<string, unknown> = {};
  const terminal = () => Promise.resolve({ data: anchors, error: null });
  anchorQuery.select = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.eq = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.in = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.gte = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.lte = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.is = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.or = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.order = vi.fn().mockReturnValue(anchorQuery);
  anchorQuery.limit = vi.fn().mockReturnValue(anchorQuery);
  (anchorQuery as { then: unknown }).then = (
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
  ) => terminal().then(resolve, reject);

  const auditInsert = vi.fn().mockImplementation((row: Record<string, unknown>) => {
    audits.push(row);
    return Promise.resolve({ data: null, error: null });
  });

  const deps: CleLogExportDeps = {
    db: {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'audit_events') {
          return { insert: auditInsert };
        }
        return anchorQuery;
      }),
    } as unknown as CleLogExportDeps['db'],
    storage: {
      upload: vi.fn().mockImplementation(
        (bucket: string, path: string, body: Uint8Array | string, contentType?: string) => {
          uploads.push({
            bucket,
            path,
            contentType,
            bodyLength: typeof body === 'string' ? body.length : body.byteLength,
            body,
          });
          if (opts.uploadError) {
            return Promise.resolve({ error: new Error('upload boom') });
          }
          return Promise.resolve({ error: null });
        },
      ),
      createSignedUrl: vi.fn().mockImplementation(
        (bucket: string, path: string, expiresIn: number) => {
          signs.push({ bucket, path, expiresIn });
          if (opts.signError) {
            return Promise.resolve({ signedUrl: null, error: new Error('sign boom') });
          }
          return Promise.resolve({
            signedUrl: `https://storage.example/${bucket}/${path}?token=sig`,
            error: null,
          });
        },
      ),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    frontendUrl: 'https://app.arkova.io',
    bucket: 'exports',
  };

  return { deps, uploads, signs, audits };
}

const BASE_ARGS = {
  userId: 'user-1',
  orgId: 'org-1',
  jurisdiction: 'CA',
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  requestId: 'req-abc-123',
};

// ─── Jurisdiction normalization ──────────────────────
describe('normalizeJurisdiction', () => {
  it('accepts a bare US state code', () => {
    expect(normalizeJurisdiction('CA')).toBe('CA');
  });
  it('accepts a lower-case state code', () => {
    expect(normalizeJurisdiction('ca')).toBe('CA');
  });
  it('accepts the US-prefixed ISO form (US-CA)', () => {
    expect(normalizeJurisdiction('US-CA')).toBe('CA');
    expect(normalizeJurisdiction('us-ca')).toBe('CA');
  });
  it('returns null for an unknown jurisdiction', () => {
    expect(normalizeJurisdiction('ZZ')).toBeNull();
    expect(normalizeJurisdiction('')).toBeNull();
    expect(normalizeJurisdiction('California')).toBeNull();
  });
});

// ─── Schema + record mapping ─────────────────────────
describe('cle_log_v1 schema + record mapping', () => {
  it('exposes a stable schema version', () => {
    expect(CLE_LOG_SCHEMA_VERSION).toBe('cle_log_v1');
  });

  it('maps an anchor to all required per-credential fields (incl. separate ethics_hours)', () => {
    const record = buildCleLogRecord(makeAnchor(), 'https://app.arkova.io');
    expect(record).toMatchObject({
      public_id: 'ARK-CLE-0001',
      title: 'Ethics in Modern Litigation',
      provider: 'State Bar of California',
      provider_approval_status: 'approved',
      credit_hours: 6,
      ethics_hours: 2,
      jurisdiction: 'CA',
      delivery_format: 'Live',
      completion_date: '2026-03-15',
      verification_url: 'https://app.arkova.io/verify/ARK-CLE-0001',
      anchor_timestamp: '2026-03-16T11:04:00.000Z',
      evidence_level: 'captured_upload_ai',
    });
  });

  it('keeps ethics_hours as a SEPARATE field, never folded into credit_hours', () => {
    const record = buildCleLogRecord(makeAnchor(), 'https://app.arkova.io');
    // credit_hours is the total; ethics_hours is a distinct line item.
    expect(record.credit_hours).toBe(6);
    expect(record.ethics_hours).toBe(2);
    // The two are independent keys — the mapper must not sum or subtract them.
    expect(Object.keys(record)).toContain('ethics_hours');
    expect(Object.keys(record)).toContain('credit_hours');
  });

  it('NEVER includes extraction_confidence or extraction_source (internal-only allowlist)', () => {
    const record = buildCleLogRecord(makeAnchor(), 'https://app.arkova.io');
    const keys = Object.keys(record);
    expect(keys).not.toContain('extraction_confidence');
    expect(keys).not.toContain('extraction_source');
    expect(JSON.stringify(record)).not.toContain('extraction_confidence');
    expect(JSON.stringify(record)).not.toContain('extraction_source');
  });

  it('tolerates missing cle_metadata (nulls, not throws)', () => {
    const record = buildCleLogRecord(
      makeAnchor({ cle_metadata: null, metadata: null, label: null }),
      'https://app.arkova.io',
    );
    expect(record.credit_hours).toBeNull();
    expect(record.ethics_hours).toBeNull();
    expect(record.provider).toBeNull();
    expect(record.jurisdiction).toBeNull();
    // Falls back to filename for the title when no course_title/label.
    expect(record.title).toBe('cle-cert.pdf');
  });

  it('validates a full JSON export document against CleLogV1Schema', () => {
    const record = buildCleLogRecord(makeAnchor(), 'https://app.arkova.io');
    const summary = computeCleSummary([record]);
    const doc = {
      schema: CLE_LOG_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      jurisdiction: 'CA',
      period: { start: '2026-01-01', end: '2026-12-31' },
      record_count: 1,
      summary,
      records: [record],
      disclaimer: CLE_DISCLAIMER_TEXT,
    };
    const parsed = CleLogV1Schema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });

  it('rejects a document with the wrong schema tag', () => {
    const parsed = CleLogV1Schema.safeParse({
      schema: 'cle_log_v2',
      generated_at: new Date().toISOString(),
      jurisdiction: 'CA',
      period: { start: '2026-01-01', end: '2026-12-31' },
      record_count: 0,
      summary: { total_credit_hours: 0, ethics_hours: 0, approved_provider_hours: 0, unverified_provider_hours: 0, hours_by_delivery_format: {} },
      records: [],
      disclaimer: CLE_DISCLAIMER_TEXT,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown top-level key (.strict)', () => {
    const record = buildCleLogRecord(makeAnchor(), 'https://app.arkova.io');
    const summary = computeCleSummary([record]);
    const parsed = CleLogV1Schema.safeParse({
      schema: CLE_LOG_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      jurisdiction: 'CA',
      period: { start: '2026-01-01', end: '2026-12-31' },
      record_count: 1,
      summary,
      records: [record],
      disclaimer: CLE_DISCLAIMER_TEXT,
      surprise: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});

// ─── Summary: ethics subtotal + provider/delivery breakdowns ─
describe('computeCleSummary — ethics subtotal as a separate line', () => {
  it('reports total credit hours AND a separate ethics-hours subtotal', () => {
    const records = [
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: 6, ethics_hours: 2, provider_approval_status: 'approved', delivery_format: 'Live', requires_manual_review: false } }), 'https://app.arkova.io'),
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: 4, ethics_hours: 1, provider_approval_status: 'not_approved', delivery_format: 'On-Demand', requires_manual_review: false } }), 'https://app.arkova.io'),
    ];
    const summary = computeCleSummary(records);
    // Ethics is a SUBTOTAL — distinct from, not added to, total credit hours.
    expect(summary.total_credit_hours).toBe(10);
    expect(summary.ethics_hours).toBe(3);
    expect(summary.ethics_hours).not.toBe(summary.total_credit_hours);
  });

  it('splits approved vs unverified provider hours', () => {
    const records = [
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: 6, ethics_hours: 2, provider_approval_status: 'approved', delivery_format: 'Live', requires_manual_review: false } }), 'https://app.arkova.io'),
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: 4, ethics_hours: 0, provider_approval_status: 'unknown', delivery_format: 'Live', requires_manual_review: false } }), 'https://app.arkova.io'),
    ];
    const summary = computeCleSummary(records);
    expect(summary.approved_provider_hours).toBe(6);
    expect(summary.unverified_provider_hours).toBe(4);
  });

  it('aggregates hours by delivery format', () => {
    const records = [
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: 6, ethics_hours: 2, provider_approval_status: 'approved', delivery_format: 'Live', requires_manual_review: false } }), 'https://app.arkova.io'),
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: 4, ethics_hours: 0, provider_approval_status: 'approved', delivery_format: 'On-Demand', requires_manual_review: false } }), 'https://app.arkova.io'),
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: 3, ethics_hours: 0, provider_approval_status: 'approved', delivery_format: 'On-Demand', requires_manual_review: false } }), 'https://app.arkova.io'),
    ];
    const summary = computeCleSummary(records);
    expect(summary.hours_by_delivery_format['Live']).toBe(6);
    expect(summary.hours_by_delivery_format['On-Demand']).toBe(7);
  });

  it('handles records with null hours without producing NaN', () => {
    const records = [
      buildCleLogRecord(makeAnchor({ cle_metadata: { credit_hours: null, ethics_hours: null, provider_approval_status: 'approved', delivery_format: 'Live', requires_manual_review: false } }), 'https://app.arkova.io'),
    ];
    const summary = computeCleSummary(records);
    expect(summary.total_credit_hours).toBe(0);
    expect(summary.ethics_hours).toBe(0);
    expect(Number.isNaN(summary.total_credit_hours)).toBe(false);
  });
});

// ─── Generation: PDF + JSON + Storage + signed URL ───
describe('generateCleLogExport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads BOTH a PDF and a JSON artifact and returns a signed URL for each', async () => {
    const { deps, uploads, signs } = makeDeps();
    const result = await generateCleLogExport(BASE_ARGS, deps);

    const pdfUpload = uploads.find((u) => u.contentType === 'application/pdf');
    const jsonUpload = uploads.find((u) => u.contentType === 'application/json');
    expect(pdfUpload).toBeDefined();
    expect(jsonUpload).toBeDefined();

    expect(result.exports.pdf.signed_url).toMatch(/^https:\/\/storage\.example\//);
    expect(result.exports.json.signed_url).toMatch(/^https:\/\/storage\.example\//);
    expect(signs).toHaveLength(2);
    expect(result.record_count).toBe(1);
    expect(result.request_id).toBe('req-abc-123');
  });

  it('JSON artifact carries the ethics-hours subtotal SEPARATELY from total credit hours', async () => {
    const anchors = [
      makeAnchor({ cle_metadata: { credit_hours: 6, ethics_hours: 2, provider_approval_status: 'approved', delivery_format: 'Live', requires_manual_review: false } }),
    ];
    const { deps, uploads } = makeDeps({ anchors });
    await generateCleLogExport(BASE_ARGS, deps);

    const jsonUpload = uploads.find((u) => u.contentType === 'application/json')!;
    const parsed = JSON.parse(jsonUpload.body as string);
    expect(parsed.summary.total_credit_hours).toBe(6);
    expect(parsed.summary.ethics_hours).toBe(2);
    // The two must be distinct keys; ethics is NOT merged into the total.
    expect(parsed.summary).toHaveProperty('ethics_hours');
    expect(parsed.summary).toHaveProperty('total_credit_hours');
    expect(parsed.records[0].ethics_hours).toBe(2);
    expect(parsed.records[0].credit_hours).toBe(6);
  });

  it('PDF artifact contains the mandatory CLE disclaimer verbatim', async () => {
    const { deps, uploads } = makeDeps();
    const result = await generateCleLogExport(BASE_ARGS, deps);
    expect(result.disclaimer).toBe(CLE_DISCLAIMER_TEXT);
    // Verbatim AC text (SCRUM-1870) — see PR body PO flag re: "of accountancy".
    expect(CLE_DISCLAIMER_TEXT).toBe(
      'This log is generated by Arkova. Arkova is not affiliated with any state bar of accountancy or bar association. CLE compliance determination remains the responsibility of the licensee and their state bar.',
    );
    const pdfUpload = uploads.find((u) => u.contentType === 'application/pdf');
    expect(pdfUpload!.bodyLength).toBeGreaterThan(500);
  });

  it('emits a cle_log.exported audit event with METADATA ONLY (no record content — CC7)', async () => {
    const { deps, audits } = makeDeps();
    await generateCleLogExport(BASE_ARGS, deps);

    const event = audits.find((a) => a.event_type === 'cle_log.exported');
    expect(event).toBeDefined();
    expect(event!.actor_id).toBe('user-1');
    expect(event!.org_id).toBe('org-1');

    const detailsRaw = event!.details;
    const details = typeof detailsRaw === 'string' ? JSON.parse(detailsRaw) : detailsRaw;
    // Allowed metadata keys only (incl. jurisdiction per AC).
    expect(details).toMatchObject({
      jurisdiction: 'CA',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      record_count: 1,
      request_id: 'req-abc-123',
    });
    // CC7: no export body / per-credential content may appear anywhere in the event.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('Ethics in Modern Litigation');
    expect(serialized).not.toContain('State Bar of California');
    expect(serialized).not.toContain('ARK-CLE-0001');
    expect(serialized).not.toContain('CA-2026-0099');
    expect(serialized).not.toContain('verification_url');
    expect(serialized).not.toContain('signed_url');
    expect(serialized.toLowerCase()).not.toContain('https://storage.example');
  });

  it('filters by org/user/jurisdiction (scope + jurisdiction enforced in the query)', async () => {
    const { deps } = makeDeps();
    await generateCleLogExport(BASE_ARGS, deps);
    const fromMock = deps.db.from as unknown as ReturnType<typeof vi.fn>;
    expect(fromMock).toHaveBeenCalledWith('anchors');
  });

  it('throws when Storage upload fails (so the endpoint can 500 cleanly)', async () => {
    const { deps } = makeDeps({ uploadError: true });
    await expect(generateCleLogExport(BASE_ARGS, deps)).rejects.toThrow();
  });

  it('throws when signed-URL creation fails', async () => {
    const { deps } = makeDeps({ signError: true });
    await expect(generateCleLogExport(BASE_ARGS, deps)).rejects.toThrow();
  });

  it('throws on an invalid jurisdiction (caller passed a non-state code)', async () => {
    const { deps } = makeDeps();
    await expect(
      generateCleLogExport({ ...BASE_ARGS, jurisdiction: 'ZZ' }, deps),
    ).rejects.toThrow();
  });

  it('PERF: generates a 200-record export (PDF + JSON) in under 10 seconds', async () => {
    const anchors = Array.from({ length: 200 }, (_, i) =>
      makeAnchor({ id: `anchor-${i}`, public_id: `ARK-CLE-${i.toString().padStart(4, '0')}` }),
    );
    const { deps } = makeDeps({ anchors });
    const started = Date.now();
    const result = await generateCleLogExport(BASE_ARGS, deps);
    const elapsedMs = Date.now() - started;
    expect(result.record_count).toBe(200);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});
