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

import { Request, Response } from 'express';
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
