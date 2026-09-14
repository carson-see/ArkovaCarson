/**
 * SCRUM-3972 (CTO ruling R20) — affiliated-organization event EMISSION SITES.
 *
 * What these pin, and why each one is a defect class rather than a nicety:
 *
 *  - each of the seven events fires exactly once, at its own transition, with
 *    the right parent/affiliate pair. "Exactly once" is the interesting half:
 *    `POST /credits` and `POST /offboard` both move credits, and an emitter
 *    shared between them would double-report a reclaim;
 *  - `suborg.suspended` is NOT emitted when the affiliate was already
 *    suspended — announcing a transition that did not happen is the false-claim
 *    class CLAUDE.md §1.13 R-7 forbids;
 *  - a failing or throwing dispatch NEVER changes the HTTP status. The emitter
 *    is void-dispatched after the response-determining work, so a webhook
 *    problem cannot turn a completed offboarding into a 500 the caller retries.
 *
 * The emitter itself is mocked here: this file is about WHEN and WITH WHAT it
 * is called. Its payload projection is covered in
 * `services/worker/src/webhooks/subOrgEvents.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { mockEmit } = vi.hoisted(() => ({
  mockEmit: vi.fn(async () => ({ ok: true, dispatched: 1, failures: [] })),
}));

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({ config: { frontendUrl: 'https://app.test' } }));
vi.mock('../../email/templates.js', () => ({
  buildInvitationEmail: vi.fn(() => ({ subject: 'x', html: '<p>x</p>' })),
}));
vi.mock('../../email/sender.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'e1' })),
}));
vi.mock('../../webhooks/subOrgEvents.js', () => ({ emitSubOrgEvent: mockEmit }));

import { orgSubOrgsRouter, allocateSubOrgCreditsCore } from './orgSubOrgs.js';
import { db } from '../../utils/db.js';
import { buildApp as buildAppFromRouter } from './__testHelpers.js';

const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '44444444-4444-4444-8444-444444444444';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';

function buildApp(userId?: string) {
  return buildAppFromRouter(orgSubOrgsRouter, '/api/v1/org/sub-orgs', {
    userId,
    injectUserId: (req, uid) => {
      (req as unknown as { userId: string }).userId = uid;
    },
  });
}

const from = () => db.from as ReturnType<typeof vi.fn>;
const rpc = () => db.rpc as ReturnType<typeof vi.fn>;

/** The emission is void-dispatched; give the microtask queue a turn. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function emitted(eventType: string) {
  return (mockEmit.mock.calls as unknown as Array<[Record<string, unknown>]>)
    .map((c) => c[0])
    .filter((a) => a.eventType === eventType);
}

// ─── approve / revoke ───────────────────────────────────────────────────────

/**
 * Minimal DB for the shared approve/revoke handler: membership → child row →
 * cap (approve only) → scoped status update → audit insert.
 */
function mockStatusActionDb(childStatus: 'PENDING' | 'APPROVED' | 'REVOKED' | null) {
  from().mockImplementation((table: string) => {
    if (table === 'org_members') {
      const chain: Record<string, unknown> = {};
      chain.eq = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: { org_id: PARENT, role: 'owner' }, error: null });
      return { select: () => chain };
    }
    if (table === 'organizations') {
      return {
        select: (columns: string) => {
          if (columns.includes('display_name')) {
            const chain: Record<string, unknown> = {};
            chain.eq = () => chain;
            chain.single = () =>
              Promise.resolve({
                data: {
                  id: CHILD,
                  parent_org_id: PARENT,
                  parent_approval_status: childStatus,
                  display_name: 'Nairobi Legal Aid',
                },
                error: null,
              });
            return chain;
          }
          if (columns.includes('max_sub_orgs')) {
            const chain: Record<string, unknown> = {};
            chain.eq = () => chain;
            chain.maybeSingle = () => Promise.resolve({ data: { max_sub_orgs: 20 }, error: null });
            return chain;
          }
          // cap children enumeration
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.then = (r: (v: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(r);
          return chain;
        },
        update: () => {
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.is = () => chain;
          chain.select = () => chain;
          chain.maybeSingle = () => Promise.resolve({ data: { id: CHILD }, error: null });
          return chain;
        },
      };
    }
    if (table === 'audit_events') {
      return { insert: () => Promise.resolve({ error: null }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe('affiliated-organization event emission (SCRUM-3972)', () => {
  beforeEach(() => {
    from().mockReset();
    rpc().mockReset();
    mockEmit.mockReset();
    mockEmit.mockResolvedValue({ ok: true, dispatched: 1, failures: [] });
  });

  it('emits suborg.approved exactly once on approve', async () => {
    mockStatusActionDb('PENDING');
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).toBe(200);
    expect(emitted('suborg.approved')).toHaveLength(1);
    expect(emitted('suborg.approved')[0]).toMatchObject({
      parentOrgId: PARENT,
      childOrgId: CHILD,
    });
    expect(emitted('suborg.revoked')).toHaveLength(0);
  });

  it('emits suborg.revoked exactly once on revoke', async () => {
    mockStatusActionDb('APPROVED');
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/revoke')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).toBe(200);
    expect(emitted('suborg.revoked')).toHaveLength(1);
    expect(emitted('suborg.approved')).toHaveLength(0);
  });

  it('emits nothing when the transition is refused', async () => {
    // Already APPROVED → 400, no write, and therefore no event: an event is a
    // claim that something changed.
    mockStatusActionDb('APPROVED');
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('emits nothing when the caller is not authorised', async () => {
    from().mockImplementation((table: string) => {
      if (table === 'org_members') {
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.limit = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: { org_id: PARENT, role: 'member' }, error: null });
        return { select: () => chain };
      }
      throw new Error(`unexpected table ${table}`);
    });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).toBe(403);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ─── credits ──────────────────────────────────────────────────────────────

  it('emits no approval when the required audit write fails', async () => {
    mockStatusActionDb('PENDING');
    const prior = from().getMockImplementation() as (table: string) => unknown;
    from().mockImplementation((table: string) => table === 'audit_events'
      ? { insert: () => Promise.resolve({ error: { message: 'audit unavailable' } }) }
      : prior(table));
    const res = await request(buildApp(ADMIN)).post('/api/v1/org/sub-orgs/approve').send({ childOrgId: CHILD });
    await settle();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('audit_write_failed');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  function mockCreditsDb() {
    from().mockImplementation((table: string) => {
      if (table === 'org_members') {
        const all = { data: [{ org_id: PARENT, role: 'owner' }], error: null };
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.limit = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: { org_id: PARENT, role: 'owner' }, error: null });
        chain.then = (r: (v: unknown) => unknown) => Promise.resolve(all).then(r);
        return { select: () => chain };
      }
      throw new Error(`unexpected table ${table}`);
    });
  }

  it('emits suborg.credits_allocated with the post-transaction balances', async () => {
    mockCreditsDb();
    rpc().mockResolvedValueOnce({
      data: { success: true, parent_balance: 900, child_balance: 100 },
      error: null,
    });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: 100, note: 'Q3' });
    await settle();

    expect(res.status).toBe(200);
    expect(emitted('suborg.credits_allocated')).toHaveLength(1);
    expect(emitted('suborg.credits_allocated')[0]).toMatchObject({
      parentOrgId: PARENT,
      childOrgId: CHILD,
      data: { amount: 100, parent_balance: 900, child_balance: 100, note: 'Q3' },
    });
    expect(emitted('suborg.credits_reclaimed')).toHaveLength(0);
  });

  it('emits suborg.credits_reclaimed when the amount is negative', async () => {
    mockCreditsDb();
    rpc().mockResolvedValueOnce({
      data: { success: true, parent_balance: 1000, child_balance: 0 },
      error: null,
    });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: -100 });
    await settle();

    expect(res.status).toBe(200);
    expect(emitted('suborg.credits_reclaimed')).toHaveLength(1);
    expect(emitted('suborg.credits_reclaimed')[0]).toMatchObject({
      data: { amount: -100, note: null },
    });
    expect(emitted('suborg.credits_allocated')).toHaveLength(0);
  });

  it('emits nothing when the credit RPC refuses the move', async () => {
    mockCreditsDb();
    rpc().mockResolvedValueOnce({ data: { error: 'insufficient_parent_balance' }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: 100 });
    await settle();

    expect(res.status).not.toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ─── offboard ─────────────────────────────────────────────────────────────

  it.each(['user', 'api_key'] as const)('emits one credit movement from the shared %s core', async (kind) => {
    rpc().mockResolvedValueOnce({ data: { success: true, parent_balance: 900, child_balance: 100 }, error: null });
    const caller = kind === 'user' ? { kind, orgId: PARENT, userId: ADMIN } : { kind, orgId: PARENT, apiKeyId: ADMIN, keyPrefix: 'test' };
    expect((await allocateSubOrgCreditsCore(caller, CHILD, 100, null)).status).toBe(200);
    expect(mockEmit).toHaveBeenCalledExactlyOnceWith({
      eventType: 'suborg.credits_allocated', parentOrgId: PARENT, childOrgId: CHILD,
      data: { amount: 100, parent_balance: 900, child_balance: 100, note: null },
    });
  });

  it('emits reclaim, suspension and offboarding exactly once each', async () => {
    mockCreditsDb();
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 40, already_suspended: false, parent_balance: 140, child_balance: 0 }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD, reason: 'engagement ended' });
    await settle();

    expect(res.status).toBe(200);
    // The atomic offboard core emits once after one committed RPC.
    expect(rpc()).toHaveBeenCalledTimes(1);
    expect(rpc().mock.calls[0][0]).toBe('offboard_suborg');
    expect(emitted('suborg.credits_reclaimed')).toHaveLength(1);
    expect(emitted('suborg.credits_reclaimed')[0]).toMatchObject({
      data: { amount: -40, parent_balance: 140, child_balance: 0 },
    });
    expect(emitted('suborg.suspended')).toHaveLength(1);
    expect(emitted('suborg.offboarded')).toHaveLength(1);
    expect(emitted('suborg.offboarded')[0]).toMatchObject({
      data: { reclaimed: 40, reason: 'engagement ended' },
    });
  });

  it('does not emit a credits reclaim when the affiliate held nothing', async () => {
    mockCreditsDb();
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 0, parent_balance: 100, child_balance: 0 }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).toBe(200);
    expect(emitted('suborg.credits_reclaimed')).toHaveLength(0);
    expect(emitted('suborg.offboarded')[0]).toMatchObject({ data: { reclaimed: 0 } });
  });

  it('does not claim a suspension that did not happen', async () => {
    // already_suspended: the RPC succeeded without a transition. Emitting
    // suborg.suspended here would tell a subscriber something changed when
    // nothing did.
    mockCreditsDb();
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 0, parent_balance: 100, child_balance: 0, already_suspended: true }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).toBe(200);
    expect(emitted('suborg.suspended')).toHaveLength(0);
    // The operation itself did complete, so the offboarding event still fires.
    expect(emitted('suborg.offboarded')).toHaveLength(1);
  });

  it('emits nothing when the reclaim fails, because nothing was suspended', async () => {
    mockCreditsDb();
    rpc().mockResolvedValueOnce({ data: { error: 'insufficient_child_balance' }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).not.toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ─── the dispatch must never move the status code ─────────────────────────

  it.each([
    ['a rejected emitter', () => mockEmit.mockRejectedValue(new Error('webhook exploded'))],
    ['a non-ok emitter', () => mockEmit.mockResolvedValue({ ok: false, dispatched: 0, failures: [] })],
  ])('returns 200 with %s', async (_label, arrange) => {
    mockCreditsDb();
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 40, already_suspended: false, parent_balance: 140, child_balance: 0 }, error: null });
    arrange();

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });
    await settle();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reclaimed: 40, suspended: true });
  });

  it('cannot throw synchronously into a route, by construction', async () => {
    // The two cases above cover a REJECTED emitter. A SYNCHRONOUS throw would
    // escape the `void` and land in the route's try/catch, turning a completed
    // offboarding into a 500 the caller would retry. That is impossible rather
    // than merely unlikely: `emitSubOrgEvent` is declared `async`, so the
    // language converts any synchronous throw in its body into a rejection.
    // Pinned here so a refactor to a non-async wrapper (e.g. one that validates
    // its argument before returning a promise) fails this test instead of
    // silently reintroducing the hazard.
    const real = await vi.importActual<typeof import('../../webhooks/subOrgEvents.js')>(
      '../../webhooks/subOrgEvents.js',
    );
    expect(real.emitSubOrgEvent.constructor.name).toBe('AsyncFunction');
  });
});
