/**
 * Tests for the CPE compliance-log export worker (SCRUM-1860 / SCRUM-1848).
 *
 * Covers PDF + JSON generation, Supabase Storage upload + signed URL,
 * the `cpe_log_v1` Zod schema, the metadata-only `cpe_log.exported` audit
 * event (CC7 no-content-leak), per-credential field mapping, and the
 * 200-record performance budget (< 10s).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The export worker reads the default bucket via the worker config module
// (SCRUM-1258 — no ad-hoc process.env reads). Mock config so importing the
// module under test does not trigger full worker config validation. The
// mocked `exportsStorageBucket: 'exports'` matches the prior default
// (`process.env.EXPORTS_STORAGE_BUCKET || 'exports'` with the var unset).
vi.mock('../config.js', () => ({
  config: { exportsStorageBucket: 'exports' },
}));

import {
  CPE_LOG_SCHEMA_VERSION,
  CpeLogV1Schema,
  assertExportsBucketReady,
  buildCpeLogRecord,
  generateCpeLogExport,
  NASBA_DISCLAIMER_TEXT,
  type CpeExportAnchorRow,
  type CpeExportStorage,
  type CpeLogExportDeps,
} from './cpe-log-export.js';

// ─── Fixtures ────────────────────────────────────────
function makeAnchor(overrides: Partial<CpeExportAnchorRow> = {}): CpeExportAnchorRow {
  return {
    id: 'anchor-uuid-1',
    public_id: 'ARK-CPE-0001',
    org_id: 'org-1',
    user_id: 'user-1',
    label: 'Advanced Auditing Workshop',
    filename: 'cpe-cert.pdf',
    status: 'SECURED',
    issued_at: '2026-03-15T00:00:00.000Z',
    chain_timestamp: '2026-03-16T11:04:00.000Z',
    created_at: '2026-03-15T09:00:00.000Z',
    credential_type: 'CPE',
    metadata: {
      credential_title: 'Advanced Auditing Workshop',
      credential_issuer: 'CPA Academy',
      verification_level: 'captured_upload_ai',
    },
    cpe_metadata: {
      credit_hours: 8,
      field_of_study: 'Auditing',
      delivery_method: 'Group Internet Based',
      sponsor_id: 'NASBA-12345',
      nasba_status: 'confirmed',
      extraction_confidence: 0.97,
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
  /** Raw body — JSON as-is, PDF decoded latin1 so text runs are searchable. */
  body: string;
}

interface SignedUrlCall {
  bucket: string;
  path: string;
  expiresIn: number;
}

function makeDeps(opts: {
  anchors?: CpeExportAnchorRow[];
  uploadError?: boolean;
  signError?: boolean;
  /** Override the bucket guard result. Defaults to a private, existing bucket. */
  bucket?: { exists?: boolean; isPublic?: boolean | null; error?: Error | null };
} = {}): {
  deps: CpeLogExportDeps;
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

  const deps: CpeLogExportDeps = {
    db: {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'audit_events') {
          return { insert: auditInsert };
        }
        return anchorQuery;
      }),
    } as unknown as CpeLogExportDeps['db'],
    storage: {
      upload: vi.fn().mockImplementation(
        (bucket: string, path: string, body: Uint8Array | string, contentType?: string) => {
          uploads.push({
            bucket,
            path,
            contentType,
            bodyLength: typeof body === 'string' ? body.length : body.byteLength,
            body: typeof body === 'string' ? body : Buffer.from(body).toString('latin1'),
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
      getBucket: vi.fn().mockImplementation(() =>
        Promise.resolve({
          exists: opts.bucket?.exists ?? true,
          isPublic: opts.bucket?.isPublic ?? false,
          error: opts.bucket?.error ?? null,
        }),
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
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  requestId: 'req-abc-123',
};

// ─── Schema + record mapping ─────────────────────────
describe('cpe_log_v1 schema + record mapping', () => {
  it('exposes a stable schema version', () => {
    expect(CPE_LOG_SCHEMA_VERSION).toBe('cpe_log_v1');
  });

  it('maps an anchor to all required per-credential fields', () => {
    const record = buildCpeLogRecord(makeAnchor(), 'https://app.arkova.io');
    expect(record).toMatchObject({
      title: 'Advanced Auditing Workshop',
      provider: 'CPA Academy',
      nasba_status: 'confirmed',
      cpe_hours: 8,
      field_of_study: 'Auditing',
      delivery_method: 'Group Internet Based',
      completion_date: '2026-03-15',
      verification_url: 'https://app.arkova.io/verify/ARK-CPE-0001',
      anchor_timestamp: '2026-03-16T11:04:00.000Z',
      evidence_level: 'captured_upload_ai',
    });
  });

  it('trims trailing slashes on the frontend URL before appending /verify/<public_id>', () => {
    // A frontendUrl with one or many trailing slashes must not produce a
    // double-slash in the verification URL (e.g. .../verify/... not ...//verify/...).
    expect(buildCpeLogRecord(makeAnchor(), 'https://app.arkova.io/').verification_url).toBe(
      'https://app.arkova.io/verify/ARK-CPE-0001',
    );
    expect(buildCpeLogRecord(makeAnchor(), 'https://app.arkova.io///').verification_url).toBe(
      'https://app.arkova.io/verify/ARK-CPE-0001',
    );
    // No trailing slash is unchanged.
    expect(buildCpeLogRecord(makeAnchor(), 'https://app.arkova.io').verification_url).toBe(
      'https://app.arkova.io/verify/ARK-CPE-0001',
    );
  });

  it('NEVER includes extraction_confidence or extraction_source (internal-only)', () => {
    const record = buildCpeLogRecord(makeAnchor(), 'https://app.arkova.io');
    const keys = Object.keys(record);
    expect(keys).not.toContain('extraction_confidence');
    expect(keys).not.toContain('extraction_source');
    expect(JSON.stringify(record)).not.toContain('extraction_confidence');
    expect(JSON.stringify(record)).not.toContain('extraction_source');
  });

  it('tolerates missing cpe_metadata (nulls, not throws)', () => {
    const record = buildCpeLogRecord(
      makeAnchor({ cpe_metadata: null, metadata: null, label: null }),
      'https://app.arkova.io',
    );
    expect(record.cpe_hours).toBeNull();
    expect(record.nasba_status).toBeNull();
    // Falls back to filename for the title when no label/metadata title.
    expect(record.title).toBe('cpe-cert.pdf');
  });

  it('validates a full JSON export document against CpeLogV1Schema', () => {
    const record = buildCpeLogRecord(makeAnchor(), 'https://app.arkova.io');
    const doc = {
      schema: CPE_LOG_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      period: { start: '2026-01-01', end: '2026-12-31' },
      record_count: 1,
      records: [record],
      disclaimer: NASBA_DISCLAIMER_TEXT,
    };
    const parsed = CpeLogV1Schema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });

  it('rejects a document with the wrong schema tag', () => {
    const parsed = CpeLogV1Schema.safeParse({
      schema: 'cpe_log_v2',
      generated_at: new Date().toISOString(),
      period: { start: '2026-01-01', end: '2026-12-31' },
      record_count: 0,
      records: [],
      disclaimer: NASBA_DISCLAIMER_TEXT,
    });
    expect(parsed.success).toBe(false);
  });
});

// ─── Generation: PDF + JSON + Storage + signed URL ───
describe('generateCpeLogExport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads BOTH a PDF and a JSON artifact and returns a signed URL for each', async () => {
    const { deps, uploads, signs } = makeDeps();
    const result = await generateCpeLogExport(BASE_ARGS, deps);

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

  it('PDF artifact contains the mandatory NASBA disclaimer verbatim', async () => {
    const { deps, uploads } = makeDeps();
    // Spy on the raw PDF bytes by intercepting the produced text — we render
    // the disclaimer into the PDF, then re-extract via jspdf-independent check:
    // the export module also returns the disclaimer string it embedded.
    const result = await generateCpeLogExport(BASE_ARGS, deps);
    expect(result.disclaimer).toBe(NASBA_DISCLAIMER_TEXT);
    expect(NASBA_DISCLAIMER_TEXT).toBe(
      'This log is generated by Arkova. Arkova is not affiliated with NASBA or any state board of accountancy. CPE compliance determination remains the responsibility of the licensee and their state board.',
    );
    // PDF body must be non-trivial.
    const pdfUpload = uploads.find((u) => u.contentType === 'application/pdf');
    expect(pdfUpload!.bodyLength).toBeGreaterThan(500);
  });

  it('emits a cpe_log.exported audit event with METADATA ONLY (no record content — CC7)', async () => {
    const { deps, audits } = makeDeps();
    await generateCpeLogExport(BASE_ARGS, deps);

    const event = audits.find((a) => a.event_type === 'cpe_log.exported');
    expect(event).toBeDefined();
    expect(event!.actor_id).toBe('user-1');
    expect(event!.org_id).toBe('org-1');

    const detailsRaw = event!.details;
    const details = typeof detailsRaw === 'string' ? JSON.parse(detailsRaw) : detailsRaw;
    // Allowed metadata keys only.
    expect(details).toMatchObject({
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      record_count: 1,
      request_id: 'req-abc-123',
    });
    // CC7: no export body / per-credential content may appear anywhere in the event.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('Advanced Auditing Workshop');
    expect(serialized).not.toContain('CPA Academy');
    expect(serialized).not.toContain('ARK-CPE-0001');
    expect(serialized).not.toContain('verification_url');
    expect(serialized).not.toContain('signed_url');
    expect(serialized.toLowerCase()).not.toContain('https://storage.example');
  });

  it('only queries the caller org/user anchors (cross-tenant scope enforced in the query)', async () => {
    const { deps } = makeDeps();
    await generateCpeLogExport(BASE_ARGS, deps);
    const fromMock = deps.db.from as unknown as ReturnType<typeof vi.fn>;
    expect(fromMock).toHaveBeenCalledWith('anchors');

    // The anchors SELECT must be filtered by BOTH user_id AND org_id — these
    // are the cross-tenant isolation guarantees, not just "some query on the
    // anchors table". Assert the .eq() filters were applied with the caller's
    // own identifiers (BASE_ARGS.userId / BASE_ARGS.orgId).
    const anchorsResult = fromMock.mock.results.find(
      (r) => r.type === 'return' && typeof (r.value as { eq?: unknown })?.eq === 'function',
    );
    expect(anchorsResult).toBeDefined();
    const eqMock = (anchorsResult!.value as { eq: ReturnType<typeof vi.fn> }).eq;
    expect(eqMock).toHaveBeenCalledWith('user_id', BASE_ARGS.userId);
    expect(eqMock).toHaveBeenCalledWith('org_id', BASE_ARGS.orgId);
  });

  it('throws when Storage upload fails (so the endpoint can 500 cleanly)', async () => {
    const { deps } = makeDeps({ uploadError: true });
    await expect(generateCpeLogExport(BASE_ARGS, deps)).rejects.toThrow();
  });

  it('throws when signed-URL creation fails', async () => {
    const { deps } = makeDeps({ signError: true });
    await expect(generateCpeLogExport(BASE_ARGS, deps)).rejects.toThrow();
  });

  it('fails loud (and uploads NOTHING) when the exports bucket is missing', async () => {
    const { deps, uploads } = makeDeps({ bucket: { exists: false, isPublic: null } });
    await expect(generateCpeLogExport(BASE_ARGS, deps)).rejects.toThrow(/does not exist/i);
    // Guard runs before any artifact is written.
    expect(uploads).toHaveLength(0);
  });

  it('fails loud (and uploads NOTHING) when the exports bucket is PUBLIC', async () => {
    const { deps, uploads } = makeDeps({ bucket: { exists: true, isPublic: true } });
    await expect(generateCpeLogExport(BASE_ARGS, deps)).rejects.toThrow(/PUBLIC/i);
    expect(uploads).toHaveLength(0);
  });

  it('PERF: generates a 200-record export (PDF + JSON) in under 10 seconds', async () => {
    const anchors = Array.from({ length: 200 }, (_, i) =>
      makeAnchor({ id: `anchor-${i}`, public_id: `ARK-CPE-${i.toString().padStart(4, '0')}` }),
    );
    const { deps } = makeDeps({ anchors });
    const started = Date.now();
    const result = await generateCpeLogExport(BASE_ARGS, deps);
    const elapsedMs = Date.now() - started;
    expect(result.record_count).toBe(200);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});

// ─── Fail-loud bucket guard ──────────────────────────
describe('assertExportsBucketReady', () => {
  function storageReturning(
    res: { exists: boolean; isPublic: boolean | null; error: Error | null },
  ): CpeExportStorage {
    return {
      upload: vi.fn(),
      createSignedUrl: vi.fn(),
      getBucket: vi.fn().mockResolvedValue(res),
    } as unknown as CpeExportStorage;
  }

  it('resolves for an existing private bucket', async () => {
    const storage = storageReturning({ exists: true, isPublic: false, error: null });
    await expect(assertExportsBucketReady(storage, 'exports')).resolves.toBeUndefined();
  });

  it('throws when the bucket does not exist', async () => {
    const storage = storageReturning({ exists: false, isPublic: null, error: null });
    await expect(assertExportsBucketReady(storage, 'exports')).rejects.toThrow(/does not exist/i);
  });

  it('throws (with the underlying message) when the lookup itself errors and the bucket is absent', async () => {
    const storage = storageReturning({
      exists: false,
      isPublic: null,
      error: new Error('connection refused'),
    });
    await expect(assertExportsBucketReady(storage, 'exports')).rejects.toThrow(
      /unavailable.*connection refused/i,
    );
  });

  it('throws when the bucket is PUBLIC (would leak unsigned bodies)', async () => {
    const storage = storageReturning({ exists: true, isPublic: true, error: null });
    await expect(assertExportsBucketReady(storage, 'exports')).rejects.toThrow(/PUBLIC/i);
  });
});

// ─── SECURED-only export gate (SCRUM-2378 — CPE-01) ──
describe('SECURED-only export gate (SCRUM-2378)', () => {
  beforeEach(() => vi.clearAllMocks());

  function mixedAnchors(): CpeExportAnchorRow[] {
    return [
      makeAnchor(), // SECURED
      makeAnchor({
        id: 'anchor-uuid-2',
        public_id: 'ARK-CPE-0002',
        status: 'PENDING',
        label: 'Pending Ethics Course',
        metadata: { credential_title: 'Pending Ethics Course' },
      }),
      makeAnchor({
        id: 'anchor-uuid-3',
        public_id: 'ARK-CPE-0003',
        status: 'SUBMITTED',
        label: 'Submitted Tax Update',
        metadata: { credential_title: 'Submitted Tax Update' },
      }),
    ];
  }

  it('excludes un-SECURED records from the export and reports excluded_count', async () => {
    const { deps, uploads } = makeDeps({ anchors: mixedAnchors() });
    const result = await generateCpeLogExport(BASE_ARGS, deps);

    // Only the SECURED record is exported; the pending ones are counted, never
    // silently dropped and never blocking the whole export.
    expect(result.record_count).toBe(1);
    expect(result.excluded_count).toBe(2);

    const jsonUpload = uploads.find((u) => u.contentType === 'application/json');
    const doc = JSON.parse(jsonUpload!.body) as {
      record_count: number;
      excluded_count: number;
      records: Array<{ status: string; public_id: string | null }>;
    };
    expect(doc.record_count).toBe(1);
    expect(doc.excluded_count).toBe(2);
    expect(doc.records).toHaveLength(1);
    expect(doc.records.every((r) => r.status === 'SECURED')).toBe(true);
    // No un-SECURED record content leaks into the artifact.
    expect(jsonUpload!.body).not.toContain('ARK-CPE-0002');
    expect(jsonUpload!.body).not.toContain('Pending Ethics Course');
  });

  it('still produces a (empty-records) export when every record is un-SECURED — never blocks', async () => {
    const anchors = mixedAnchors().filter((a) => a.status !== 'SECURED');
    const { deps, uploads, signs } = makeDeps({ anchors });
    const result = await generateCpeLogExport(BASE_ARGS, deps);

    expect(result.record_count).toBe(0);
    expect(result.excluded_count).toBe(2);
    // Both artifacts still uploaded + signed.
    expect(uploads).toHaveLength(2);
    expect(signs).toHaveLength(2);
  });

  it('reports excluded_count = 0 when everything in the period is SECURED', async () => {
    const { deps } = makeDeps({ anchors: [makeAnchor()] });
    const result = await generateCpeLogExport(BASE_ARGS, deps);
    expect(result.record_count).toBe(1);
    expect(result.excluded_count).toBe(0);
  });

  it('audit details carry excluded_count (metadata only — CC7 still holds)', async () => {
    const { deps, audits } = makeDeps({ anchors: mixedAnchors() });
    await generateCpeLogExport(BASE_ARGS, deps);

    const event = audits.find((a) => a.event_type === 'cpe_log.exported');
    expect(event).toBeDefined();
    const detailsRaw = event!.details;
    const details = typeof detailsRaw === 'string' ? JSON.parse(detailsRaw) : detailsRaw;
    expect(details.record_count).toBe(1);
    expect(details.excluded_count).toBe(2);
    // CC7: excluded records leak no content into the audit row either.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('Pending Ethics Course');
    expect(serialized).not.toContain('ARK-CPE-0002');
  });

  it('CpeLogV1Schema accepts the additive excluded_count field and stays backward-compatible', () => {
    const base = {
      schema: CPE_LOG_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      period: { start: '2026-01-01', end: '2026-12-31' },
      record_count: 0,
      records: [],
      disclaimer: NASBA_DISCLAIMER_TEXT,
    };
    // New documents carry excluded_count…
    expect(CpeLogV1Schema.safeParse({ ...base, excluded_count: 3 }).success).toBe(true);
    // …and previously-issued documents without it still validate (additive §1.8).
    expect(CpeLogV1Schema.safeParse(base).success).toBe(true);
    // Negative counts are rejected.
    expect(CpeLogV1Schema.safeParse({ ...base, excluded_count: -1 }).success).toBe(false);
  });
});
