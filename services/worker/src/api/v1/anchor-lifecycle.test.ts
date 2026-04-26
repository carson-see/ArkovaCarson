/**
 * Tests for GET /anchor/:publicId/lifecycle (API-RICH-03 / SCRUM-896)
 *
 * Pure tests on `buildLifecycleEntry` plus handler integration tests using
 * the injected `_testAnchorLookup` + `_testProfileLookup` hooks (mirrors
 * the verify endpoint pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../utils/db.js';
import { Request, Response } from 'express';
import {
  anchorLifecycleRouter,
  buildLifecycleEntry,
  type AnchorLookup,
  type AuditEventRow,
  type ProfileLookup,
} from './anchor-lifecycle.js';

function getGetHandler() {
  type Layer = { route?: { path: string; methods: { get: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } };
  const layer = (anchorLifecycleRouter as unknown as { stack: Layer[] }).stack
    .find((l) => l.route?.path === '/:publicId/lifecycle' && l.route?.methods?.get);
  return layer?.route?.stack[0].handle;
}

interface MockReqOpts {
  publicId: string;
  apiKey?: { orgId: string | null } | null;
  anchorLookup?: AnchorLookup;
  profileLookup?: ProfileLookup;
}

function createMockReqRes(opts: MockReqOpts) {
  const req = {
    params: { publicId: opts.publicId },
    apiKey: opts.apiKey ?? undefined,
    _testAnchorLookup: opts.anchorLookup,
    _testProfileLookup: opts.profileLookup,
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

function row(overrides: Partial<AuditEventRow> & { event_type: string; created_at: string }): AuditEventRow {
  return {
    event_type: overrides.event_type,
    created_at: overrides.created_at,
    actor_id: overrides.actor_id ?? null,
    details: overrides.details ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildLifecycleEntry (API-RICH-03)', () => {
  it('maps ANCHOR_CREATED → previous=null, new=PENDING, system actor', () => {
    const e = buildLifecycleEntry(
      row({ event_type: 'ANCHOR_CREATED', created_at: '2026-04-01T00:00:00Z' }),
      new Map(),
      { includeActorPublicId: false },
    );
    expect(e.previous_status).toBeNull();
    expect(e.new_status).toBe('PENDING');
    expect(e.actor_type).toBe('system');
    expect(e.actor_public_id).toBeUndefined();
  });

  it('maps ANCHOR_SECURED → previous=CONFIRMED, new=SECURED, surfaces tx_id from details', () => {
    const e = buildLifecycleEntry(
      row({
        event_type: 'ANCHOR_SECURED',
        created_at: '2026-04-01T00:00:00Z',
        details: { tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57' },
      }),
      new Map(),
      { includeActorPublicId: false },
    );
    expect(e.previous_status).toBe('CONFIRMED');
    expect(e.new_status).toBe('SECURED');
    expect(e.tx_id).toBe('b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57');
  });

  it('marks user actor when actor_id present', () => {
    const e = buildLifecycleEntry(
      row({ event_type: 'ANCHOR_REVOKED', created_at: '2026-04-01T00:00:00Z', actor_id: 'uuid-actor-1' }),
      new Map([['uuid-actor-1', 'profile-public-id-1']]),
      { includeActorPublicId: true },
    );
    expect(e.actor_type).toBe('user');
    expect(e.actor_public_id).toBe('profile-public-id-1');
  });

  it('omits actor_public_id when caller is anonymous', () => {
    const e = buildLifecycleEntry(
      row({ event_type: 'ANCHOR_REVOKED', created_at: '2026-04-01T00:00:00Z', actor_id: 'uuid-actor-1' }),
      new Map([['uuid-actor-1', 'profile-public-id-1']]),
      { includeActorPublicId: false },
    );
    expect(e).not.toHaveProperty('actor_public_id');
    // actor_id (UUID) MUST never appear in the response, regardless of caller.
    expect(JSON.stringify(e)).not.toContain('uuid-actor-1');
  });

  it('returns null/null status for unmapped event types (e.g. VERIFICATION_QUERIED)', () => {
    const e = buildLifecycleEntry(
      row({ event_type: 'VERIFICATION_QUERIED', created_at: '2026-04-01T00:00:00Z' }),
      new Map(),
      { includeActorPublicId: false },
    );
    expect(e.previous_status).toBeNull();
    expect(e.new_status).toBeNull();
    expect(e.event_type).toBe('VERIFICATION_QUERIED');
  });

  it('parses string details and tolerates malformed JSON', () => {
    const ok = buildLifecycleEntry(
      row({ event_type: 'ANCHOR_SECURED', created_at: '2026-04-01T00:00:00Z', details: '{"tx_id":"abc"}' }),
      new Map(),
      { includeActorPublicId: false },
    );
    expect(ok.tx_id).toBe('abc');

    const broken = buildLifecycleEntry(
      row({ event_type: 'ANCHOR_SECURED', created_at: '2026-04-01T00:00:00Z', details: 'not-json' }),
      new Map(),
      { includeActorPublicId: false },
    );
    expect(broken.tx_id).toBeUndefined();
  });
});

describe('GET /anchor/:publicId/lifecycle handler', () => {
  it('returns 400 for missing publicId', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: '' });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the anchor does not exist', async () => {
    const handler = getGetHandler();
    const anchorLookup: AnchorLookup = { byPublicId: vi.fn().mockResolvedValue(null) };
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-MISSING', anchorLookup });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 for cross-org API key (anchor org != caller org)', async () => {
    const handler = getGetHandler();
    const anchorLookup: AnchorLookup = {
      byPublicId: vi.fn().mockResolvedValue({ id: 'anchor-uuid-1', org_id: 'org-A' }),
    };
    const { req, res } = createMockReqRes({
      publicId: 'ARK-2026-XO',
      anchorLookup,
      apiKey: { orgId: 'org-B' },
    });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns ordered lifecycle for anonymous caller (no actor_public_id)', async () => {
    const handler = getGetHandler();
    const anchorLookup: AnchorLookup = {
      byPublicId: vi.fn().mockResolvedValue({ id: 'anchor-uuid-1', org_id: 'org-A' }),
    };
    const profileLookup: ProfileLookup = { publicIdsByActorIds: vi.fn().mockResolvedValue(new Map()) };
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                { event_type: 'ANCHOR_CREATED', created_at: '2026-03-10T08:00:00Z', actor_id: null, details: null },
                {
                  event_type: 'ANCHOR_SECURED',
                  created_at: '2026-03-10T10:00:00Z',
                  actor_id: 'uuid-user-1',
                  details: { tx_id: 'tx-abc' },
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    });

    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-OK', anchorLookup, profileLookup });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.public_id).toBe('ARK-2026-OK');
    expect(body.total).toBe(2);
    expect(body.lifecycle[0].event_type).toBe('ANCHOR_CREATED');
    expect(body.lifecycle[0].new_status).toBe('PENDING');
    expect(body.lifecycle[1].new_status).toBe('SECURED');
    expect(body.lifecycle[1].tx_id).toBe('tx-abc');
    // Anonymous: no actor_public_id field; never any UUID.
    expect(body.lifecycle[0]).not.toHaveProperty('actor_public_id');
    expect(JSON.stringify(body)).not.toContain('uuid-user-1');
    // Profile lookup should not be called when caller is anonymous.
    expect(profileLookup.publicIdsByActorIds).not.toHaveBeenCalled();
  });

  it('includes actor_public_id for API-key caller within the anchor org', async () => {
    const handler = getGetHandler();
    const anchorLookup: AnchorLookup = {
      byPublicId: vi.fn().mockResolvedValue({ id: 'anchor-uuid-1', org_id: 'org-A' }),
    };
    const profileLookup: ProfileLookup = {
      publicIdsByActorIds: vi.fn().mockResolvedValue(new Map([['uuid-user-1', 'PROFILE-PID-001']])),
    };
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  event_type: 'ANCHOR_REVOKED',
                  created_at: '2026-04-01T00:00:00Z',
                  actor_id: 'uuid-user-1',
                  details: null,
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    });

    const { req, res } = createMockReqRes({
      publicId: 'ARK-2026-OK',
      apiKey: { orgId: 'org-A' },
      anchorLookup,
      profileLookup,
    });
    await handler!(req, res);

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.lifecycle[0].actor_public_id).toBe('PROFILE-PID-001');
    expect(body.lifecycle[0].new_status).toBe('REVOKED');
    // Internal UUID still must not leak.
    expect(JSON.stringify(body)).not.toContain('uuid-user-1');
    expect(profileLookup.publicIdsByActorIds).toHaveBeenCalledWith(['uuid-user-1']);
  });

  it('returns 500 on database error reading audit_events', async () => {
    const handler = getGetHandler();
    const anchorLookup: AnchorLookup = {
      byPublicId: vi.fn().mockResolvedValue({ id: 'anchor-uuid-1', org_id: 'org-A' }),
    };
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: null, error: { message: 'db oops' } }),
          }),
        }),
      }),
    });
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-OK', anchorLookup });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
