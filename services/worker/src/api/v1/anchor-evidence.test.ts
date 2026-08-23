/**
 * Tests for GET /api/v1/anchor/:publicId/evidence (HAKI-REQ-04 / SCRUM-1173).
 *
 * Pure tests on `buildEvidencePackage` plus handler integration tests using
 * the injected `_testEvidenceLookup` hook (mirrors the verify + lifecycle
 * endpoint patterns).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: { bitcoinNetwork: 'mainnet', frontendUrl: 'https://app.arkova.ai' },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Request, Response } from 'express';
import { db } from '../../utils/db.js';
import {
  anchorEvidenceRouter,
  buildEvidencePackage,
  type EvidenceLookup,
  type AnchorEvidenceRow,
  type AuditEventRow,
} from './anchor-evidence.js';

function getGetHandler() {
  type Layer = {
    route?: {
      path: string;
      methods: { get: boolean };
      stack: Array<{ handle: (...args: unknown[]) => unknown }>;
    };
  };
  const layer = (anchorEvidenceRouter as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === '/:publicId/evidence' && l.route?.methods?.get,
  );
  return layer?.route?.stack[0].handle;
}

interface MockReqOpts {
  publicId: string;
  apiKey?: { orgId: string | null } | null;
  lookup?: EvidenceLookup;
}

function createMockReqRes(opts: MockReqOpts) {
  const req = {
    params: { publicId: opts.publicId },
    apiKey: opts.apiKey ?? undefined,
    _testEvidenceLookup: opts.lookup,
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function defaultAnchor(overrides: Partial<AnchorEvidenceRow> = {}): AnchorEvidenceRow {
  return {
    public_id: 'ARK-2026-A1',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    chain_block_height: 900_001,
    chain_timestamp: '2026-04-01T00:00:01Z',
    created_at: '2026-04-01T00:00:00Z',
    credential_type: 'CONTRACT',
    org_id: 'org-uuid-1',
    org_name: 'HakiChain Demo NGO',
    issued_at: '2026-03-15T00:00:00Z',
    expires_at: null,
    description: 'NGO grant agreement v3',
    jurisdiction: 'KE',
    merkle_root: 'd'.repeat(64),
    recipient_hash: 'sha256:beneficiary@example.com',
    ...overrides,
  };
}

function event(
  overrides: Partial<AuditEventRow> & { event_type: string; created_at: string },
): AuditEventRow {
  return {
    event_type: overrides.event_type,
    created_at: overrides.created_at,
    actor_id: overrides.actor_id ?? null,
    details: overrides.details ?? null,
  };
}

describe('buildEvidencePackage (SCRUM-1173)', () => {
  it('AC1: bundles verification + lifecycle + links + document-binding fields', () => {
    const pkg = buildEvidencePackage(defaultAnchor(), [], { includeActorPublicId: false });
    expect(pkg.public_id).toBe('ARK-2026-A1');
    expect(pkg.verified).toBe(true);
    expect(pkg.status).toBe('ACTIVE');
    expect(pkg.fingerprint).toBe('a'.repeat(64));
    expect(pkg.network_receipt_id).toBe(
      'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    );
    expect(pkg.bitcoin_block).toBe(900_001);
    expect(pkg.merkle_proof_hash).toBe('d'.repeat(64));
    expect(pkg.links.record_uri).toBe('https://app.arkova.ai/verify/ARK-2026-A1');
    expect(pkg.links.proof_url).toBe('https://app.arkova.ai/api/v1/verify/ARK-2026-A1/proof');
    expect(pkg.links.explorer_url).toContain('mempool.space');
    expect(pkg.links.explorer_url).toContain(
      'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    );
    expect(pkg.chain_data_available).toBe(true);
  });

  it('pentest-prep: omits the jurisdiction key entirely when the anchor has none (frozen schema §1.8)', () => {
    const pkg = buildEvidencePackage(
      defaultAnchor({ jurisdiction: null }),
      [],
      { includeActorPublicId: false },
    );
    expect(pkg).not.toHaveProperty('jurisdiction');
    expect(JSON.stringify(pkg)).not.toContain('"jurisdiction"');
  });

  it('pentest-prep: includes jurisdiction when the anchor has one', () => {
    const pkg = buildEvidencePackage(defaultAnchor({ jurisdiction: 'KE' }), [], {
      includeActorPublicId: false,
    });
    expect(pkg.jurisdiction).toBe('KE');
  });

  it('AC2: public projection — never includes raw internal UUIDs', () => {
    const pkg = buildEvidencePackage(defaultAnchor(), [], { includeActorPublicId: false });
    const serialized = JSON.stringify(pkg);
    expect(serialized).not.toContain('org-uuid-1');
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('AC4: surfaces document_issued_date AND anchored_at as separate, labeled fields', () => {
    const pkg = buildEvidencePackage(defaultAnchor(), [], { includeActorPublicId: false });
    expect(pkg.document_issued_date).toBe('2026-03-15T00:00:00Z');
    expect(pkg.anchored_at).toBe('2026-04-01T00:00:00Z');
    expect(pkg.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('anchored_at')]),
    );
  });

  it('AC4: notes about retroactive anchoring when document_issued_date < anchored_at by >= 30d', () => {
    const pkg = buildEvidencePackage(
      defaultAnchor({ issued_at: '2025-01-01T00:00:00Z', created_at: '2026-04-01T00:00:00Z' }),
      [],
      { includeActorPublicId: false },
    );
    expect(pkg.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/retroactive/i)]),
    );
  });

  it('AC6: chain_data_available=false + explicit retry guidance when chain_tx_id is null', () => {
    const pkg = buildEvidencePackage(
      defaultAnchor({ status: 'PENDING', chain_tx_id: null, chain_block_height: null, chain_timestamp: null }),
      [],
      { includeActorPublicId: false },
    );
    expect(pkg.chain_data_available).toBe(false);
    expect(pkg.network_receipt_id).toBeNull();
    expect(pkg.bitcoin_block).toBeNull();
    expect(pkg.links.explorer_url).toBeNull();
    expect(pkg.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/not yet.*confirmed|pending/i)]),
    );
  });

  it('AC1: lifecycle entries map status transitions and surface tx_id from details', () => {
    const pkg = buildEvidencePackage(
      defaultAnchor(),
      [
        event({ event_type: 'ANCHOR_CREATED', created_at: '2026-04-01T00:00:00Z' }),
        event({
          event_type: 'ANCHOR_SECURED',
          created_at: '2026-04-01T00:01:00Z',
          details: { tx_id: 'tx-abc' },
        }),
      ],
      { includeActorPublicId: false },
    );
    expect(pkg.lifecycle).toHaveLength(2);
    expect(pkg.lifecycle[0].new_status).toBe('PENDING');
    expect(pkg.lifecycle[1].new_status).toBe('SECURED');
    expect(pkg.lifecycle[1].tx_id).toBe('tx-abc');
  });

  it('AC2: lifecycle entries omit actor_public_id for anonymous callers', () => {
    const pkg = buildEvidencePackage(
      defaultAnchor(),
      [event({ event_type: 'ANCHOR_REVOKED', created_at: '2026-05-01T00:00:00Z', actor_id: 'uuid-actor-1' })],
      { includeActorPublicId: false },
    );
    expect(pkg.lifecycle[0]).not.toHaveProperty('actor_public_id');
    expect(JSON.stringify(pkg)).not.toContain('uuid-actor-1');
  });

  it('AC3: API-key callers see actor_public_id when actor map provides it', () => {
    const pkg = buildEvidencePackage(
      defaultAnchor(),
      [event({ event_type: 'ANCHOR_REVOKED', created_at: '2026-05-01T00:00:00Z', actor_id: 'uuid-actor-1' })],
      { includeActorPublicId: true, actorPublicIdMap: new Map([['uuid-actor-1', 'PROFILE-PID-1']]) },
    );
    expect(pkg.lifecycle[0].actor_public_id).toBe('PROFILE-PID-1');
    // Internal UUID still must not leak.
    expect(JSON.stringify(pkg)).not.toContain('uuid-actor-1');
  });
});

describe('GET /anchor/:publicId/evidence handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when publicId is missing', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: '' });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the anchor does not exist', async () => {
    const handler = getGetHandler();
    const lookup: EvidenceLookup = {
      byPublicId: vi.fn().mockResolvedValue(null),
      auditEventsForAnchor: vi.fn().mockResolvedValue([]),
      profilePublicIdsByActorIds: vi.fn().mockResolvedValue(new Map()),
    };
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-MISSING', lookup });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns evidence package for anonymous caller (public-safe projection)', async () => {
    const handler = getGetHandler();
    const lookup: EvidenceLookup = {
      byPublicId: vi.fn().mockResolvedValue({ anchor: defaultAnchor(), internalAnchorId: 'anchor-uuid-1' }),
      auditEventsForAnchor: vi.fn().mockResolvedValue([
        event({ event_type: 'ANCHOR_CREATED', created_at: '2026-04-01T00:00:00Z' }),
        event({ event_type: 'ANCHOR_SECURED', created_at: '2026-04-01T00:01:00Z', details: { tx_id: 'tx-abc' } }),
      ]),
      profilePublicIdsByActorIds: vi.fn().mockResolvedValue(new Map()),
    };
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-A1', lookup });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.public_id).toBe('ARK-2026-A1');
    expect(body.verified).toBe(true);
    expect(body.lifecycle).toHaveLength(2);
    // Anonymous: profile lookup must not be called.
    expect(lookup.profilePublicIdsByActorIds).not.toHaveBeenCalled();
    // No internal UUIDs in the body.
    expect(JSON.stringify(body)).not.toContain('anchor-uuid-1');
  });

  it('returns 404 for cross-org API key (anchor org != caller org)', async () => {
    const handler = getGetHandler();
    const lookup: EvidenceLookup = {
      byPublicId: vi.fn().mockResolvedValue({
        anchor: defaultAnchor({ org_id: 'org-A' }),
        internalAnchorId: 'anchor-uuid-1',
      }),
      auditEventsForAnchor: vi.fn(),
      profilePublicIdsByActorIds: vi.fn(),
    };
    const { req, res } = createMockReqRes({
      publicId: 'ARK-2026-XO',
      apiKey: { orgId: 'org-B-foreign' },
      lookup,
    });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    // Audit fetch must not run when access is denied.
    expect(lookup.auditEventsForAnchor).not.toHaveBeenCalled();
  });

  it('includes actor_public_id for API-key caller in same org', async () => {
    const handler = getGetHandler();
    const lookup: EvidenceLookup = {
      byPublicId: vi.fn().mockResolvedValue({
        anchor: defaultAnchor({ org_id: 'org-A' }),
        internalAnchorId: 'anchor-uuid-1',
      }),
      auditEventsForAnchor: vi.fn().mockResolvedValue([
        event({
          event_type: 'ANCHOR_REVOKED',
          created_at: '2026-05-01T00:00:00Z',
          actor_id: 'uuid-actor-1',
        }),
      ]),
      profilePublicIdsByActorIds: vi
        .fn()
        .mockResolvedValue(new Map([['uuid-actor-1', 'PROFILE-PID-1']])),
    };
    const { req, res } = createMockReqRes({
      publicId: 'ARK-2026-A1',
      apiKey: { orgId: 'org-A' },
      lookup,
    });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.lifecycle[0].actor_public_id).toBe('PROFILE-PID-1');
    expect(JSON.stringify(body)).not.toContain('uuid-actor-1');
    expect(lookup.profilePublicIdsByActorIds).toHaveBeenCalledWith(['uuid-actor-1']);
  });
});

/**
 * DI-398 / SCRUM-3376 — the REAL `defaultLookup` DB select.
 *
 * Every test above injects `_testEvidenceLookup`, so the production select
 * string was never exercised: it asked `anchors` for `jurisdiction`,
 * `merkle_root` and `recipient_hash`, none of which are columns on that table.
 * PostgREST answered 42703, the handler discarded `error`, and the route
 * returned 404 "Anchor not found" for EVERY anchor.
 *
 * These tests drive the route through the real `defaultLookup` against a
 * schema-faithful `db` double that rejects unknown columns exactly as PostgREST
 * does, with the known-column set parsed from the GENERATED
 * `database.types.ts` — so a future phantom column fails here rather than in
 * production.
 */
const TYPES_PATH = fileURLToPath(new URL('../../types/database.types.ts', import.meta.url));

/** Column names on `public.anchors` per the generated Supabase types. */
function anchorsRowColumns(): Set<string> {
  const src = readFileSync(TYPES_PATH, 'utf8');
  const tableIdx = src.indexOf('      anchors: {');
  if (tableIdx < 0) throw new Error('anchors table not found in database.types.ts');
  const rowIdx = src.indexOf('        Row: {', tableIdx);
  const endIdx = src.indexOf('\n        }', rowIdx);
  const cols = new Set<string>();
  for (const line of src.slice(rowIdx, endIdx).split('\n').slice(1)) {
    const m = /^\s{10}([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(line);
    if (m) cols.add(m[1]);
  }
  if (cols.size === 0) throw new Error('parsed zero anchors columns — parser drifted');
  return cols;
}

/** Split a PostgREST select on top-level commas (embeds keep their parens). */
function splitTopLevel(select: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of select) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Scalar columns requested from the BASE table (embeds excluded). */
function baseColumnsOf(select: string): string[] {
  return splitTopLevel(select)
    .filter((p) => !p.includes('('))
    .map((p) => (p.includes(':') ? p.slice(p.indexOf(':') + 1) : p).trim());
}

interface PostgrestResult {
  data: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

/** Return only the keys the select actually asked for (embeds by alias). */
function projectRow(select: string, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of splitTopLevel(select)) {
    const key = part.includes('(')
      ? (part.includes(':')
          ? part.slice(0, part.indexOf(':'))
          : part.slice(0, part.indexOf('('))
        ).trim()
      : part.trim();
    out[key] = source[key] ?? null;
  }
  return out;
}

const ANCHOR_SOURCE_ROW: Record<string, unknown> = {
  id: 'anchor-uuid-real-1',
  public_id: 'ARK-2026-REAL',
  fingerprint: 'c'.repeat(64),
  status: 'SECURED',
  chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
  chain_block_height: 900_123,
  chain_timestamp: '2026-04-02T00:00:01Z',
  created_at: '2026-04-02T00:00:00Z',
  credential_type: 'CONTRACT',
  issued_at: '2026-04-01T00:00:00Z',
  expires_at: null,
  description: 'HakiChain grant agreement',
  org_id: 'org-real-1',
  metadata: { jurisdiction: 'KE', recipient_email: 'beneficiary@example.com' },
  organization: { display_name: 'HakiChain Demo NGO' },
  anchor_proofs: { merkle_root: 'e'.repeat(64) },
};

interface FaithfulDbOpts {
  anchorRow?: Record<string, unknown> | null;
  /** Force a PostgREST error on the anchors select (DB outage / RLS regression). */
  anchorError?: { code: string; message: string };
  auditRows?: AuditEventRow[];
}

/**
 * `db` double that behaves like PostgREST: an unknown column on `anchors`
 * yields 42703 rather than silently returning null.
 */
function installFaithfulDb(opts: FaithfulDbOpts = {}) {
  const known = anchorsRowColumns();
  const captured = { anchorsSelect: '' };

  const resolveAnchors = (select: string): PostgrestResult => {
    captured.anchorsSelect = select;
    const unknown = baseColumnsOf(select).filter((c) => !known.has(c));
    if (unknown.length > 0) {
      return {
        data: null,
        error: { code: '42703', message: `column anchors.${unknown[0]} does not exist` },
      };
    }
    if (opts.anchorError) return { data: null, error: opts.anchorError };
    const source = opts.anchorRow === undefined ? ANCHOR_SOURCE_ROW : opts.anchorRow;
    if (source === null) {
      return {
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
        },
      };
    }
    return { data: projectRow(select, source), error: null };
  };

  (db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    let select = '';
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: (s: string) => {
        select = s;
        return builder;
      },
      eq: () => builder,
      is: () => builder,
      order: () => Promise.resolve({ data: opts.auditRows ?? [], error: null }),
      single: () =>
        Promise.resolve(
          table === 'anchors' ? resolveAnchors(select) : { data: null, error: null },
        ),
    });
    return builder;
  });

  return captured;
}

describe('DI-398 / SCRUM-3376: real defaultLookup select against the anchors schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests only columns that exist on public.anchors', async () => {
    const handler = getGetHandler();
    const captured = installFaithfulDb();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    const unknown = baseColumnsOf(captured.anchorsSelect).filter(
      (c) => !anchorsRowColumns().has(c),
    );
    expect(unknown).toEqual([]);
  });

  it('returns 200 with the evidence package (not 404) for an anchor that exists', async () => {
    const handler = getGetHandler();
    installFaithfulDb();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.public_id).toBe('ARK-2026-REAL');
    expect(body.verified).toBe(true);
    expect(body.issuer_name).toBe('HakiChain Demo NGO');
  });

  it('resolves merkle_proof_hash from the anchor_proofs embed', async () => {
    const handler = getGetHandler();
    installFaithfulDb();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.merkle_proof_hash).toBe('e'.repeat(64));
  });

  it('accepts the anchor_proofs embed as a one-element array (PostgREST to-one shape)', async () => {
    const handler = getGetHandler();
    installFaithfulDb({
      anchorRow: { ...ANCHOR_SOURCE_ROW, anchor_proofs: [{ merkle_root: 'f'.repeat(64) }] },
    });
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.merkle_proof_hash).toBe('f'.repeat(64));
  });

  it('falls back to legacy metadata.merkle_root when no proof row is joined', async () => {
    const handler = getGetHandler();
    installFaithfulDb({
      anchorRow: {
        ...ANCHOR_SOURCE_ROW,
        anchor_proofs: null,
        metadata: { jurisdiction: 'KE', merkle_root: 'a'.repeat(64) },
      },
    });
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.merkle_proof_hash).toBe('a'.repeat(64));
  });

  it('resolves jurisdiction from anchors.metadata', async () => {
    const handler = getGetHandler();
    installFaithfulDb();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.jurisdiction).toBe('KE');
  });

  it('omits jurisdiction entirely when metadata carries no tag (frozen schema 1.8)', async () => {
    const handler = getGetHandler();
    installFaithfulDb({ anchorRow: { ...ANCHOR_SOURCE_ROW, metadata: { merkle_root: null } } });
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect('jurisdiction' in body).toBe(false);
  });

  it('never leaks raw metadata, the internal anchor UUID, or recipient PII', async () => {
    const handler = getGetHandler();
    installFaithfulDb();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('anchor-uuid-real-1');
    expect(serialized).not.toContain('beneficiary@example.com');
    expect(body.recipient_identifier).toBeNull();
  });

  it('500s (never 404s) on a real PostgREST error — no existence-leak answer', async () => {
    const handler = getGetHandler();
    installFaithfulDb({
      anchorError: { code: '42501', message: 'permission denied for table anchors' },
    });
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-REAL' });
    await handler!(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it('still 404s when PostgREST reports no matching row (PGRST116)', async () => {
    const handler = getGetHandler();
    installFaithfulDb({ anchorRow: null });
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-GONE' });
    await handler!(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
