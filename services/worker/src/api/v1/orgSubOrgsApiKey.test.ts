/**
 * SCRUM-3971 — the API-key sub-organization surface.
 *
 * Two properties this file exists to hold, neither of which any other suite
 * covers:
 *
 *   1. **Scope.** `read:orgs` reads, `orgs:manage` writes, and `orgs:manage`
 *      satisfies `read:orgs` so an integration is not forced to hold both.
 *   2. **No raw uuid, anywhere.** §1.8 freezes this shape the moment it ships,
 *      and `check-v1-uuid-leaks.ts` is warn-only and pattern-based. The sweep
 *      at the bottom of this file walks EVERY response body recursively — it
 *      does not care what the serializer looks like, only what comes out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({ config: { frontendUrl: 'https://app.test' } }));
vi.mock('../../email/templates.js', () => ({
  buildInvitationEmail: vi.fn(() => ({ subject: 'Invite', html: '<p>Invite</p>' })),
}));
vi.mock('../../email/sender.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'email-1' })),
}));

import { db } from '../../utils/db.js';
import { requireScopeAnyAuth } from '../../middleware/requireScopeAnyAuth.js';
import { orgSubOrgsApiRouter } from './orgSubOrgsApiKey.js';

const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '44444444-4444-4444-8444-444444444444';
const KEY_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const CHILD_PUB = 'k7mqx3ptr9wz';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Mounts the key router the way `api/v1/router.ts` does. */
function buildApp(scopes: string[] | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (scopes) {
      req.apiKey = {
        keyId: KEY_ID,
        orgId: PARENT,
        userId: 'key-owner-user',
        scopes,
        rateLimitTier: 'paid',
        keyPrefix: 'ak_live_65aa',
      };
    }
    next();
  });
  app.use('/api/v1/organizations/sub-orgs', requireScopeAnyAuth('read:orgs'), orgSubOrgsApiRouter);
  return app;
}

interface OrgRow {
  id: string;
  public_id?: string | null;
  display_name?: string;
  domain?: string | null;
  verification_status?: string;
  parent_org_id?: string | null;
  parent_approval_status?: string | null;
  suspended?: boolean;
  created_at?: string;
  max_sub_orgs?: number | null;
  logo_url?: string | null;
}

const APPROVED_CHILD: OrgRow = {
  id: CHILD,
  public_id: CHILD_PUB,
  display_name: 'Client A',
  domain: 'client-a.example',
  verification_status: 'VERIFIED',
  parent_org_id: PARENT,
  parent_approval_status: 'APPROVED',
  suspended: false,
  created_at: '2026-01-01T00:00:00.000Z',
  logo_url: null,
};

const ACTING_PARENT: OrgRow = { id: PARENT, parent_org_id: null, max_sub_orgs: 20 };

function mockDb(opts: {
  organizations?: OrgRow[];
  children?: OrgRow[];
  childrenError?: { message: string };
  markers?: { org_id: string }[];
  markersError?: { message: string };
  creditBalance?: number;
} = {}) {
  const from = db.from as unknown as ReturnType<typeof vi.fn>;
  from.mockImplementation((table: string) => {
    if (table === 'organizations') {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (col: string, value: unknown) => { filters[col] = value; return chain; };
      chain.order = () => Promise.resolve(
        opts.childrenError
          ? { data: null, error: opts.childrenError }
          : { data: opts.children ?? [], error: null },
      );
      chain.maybeSingle = () => {
        const rows = [...(opts.organizations ?? [ACTING_PARENT]), ...(opts.children ?? [])];
        const hit = rows.find((row) =>
          Object.entries(filters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v));
        return Promise.resolve({ data: hit ?? null, error: null });
      };
      return chain;
    }
    if (table === 'org_integrations') {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.is = () => chain;
      chain.in = () => Promise.resolve(
        opts.markersError
          ? { data: null, error: opts.markersError }
          : { data: opts.markers ?? [], error: null },
      );
      return chain;
    }
    if (table === 'org_credits') {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: { balance: opts.creditBalance ?? 0 }, error: null });
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  });
}

/**
 * `organizations` double for the approve/revoke path, dispatched on the FILTERS
 * a chain applied rather than on a call counter. A counter encodes the current
 * query ORDER into the test, so adding or removing one read silently re-points
 * every later stub at the wrong stage (the cap read starts answering the CAS).
 */
function mockStatusActionDb(opts: {
  child: OrgRow;
  /** Rows the affiliate-cap count sees. */
  capChildren?: OrgRow[];
  maxSubOrgs?: number | null;
  /** null = the compare-and-set matched nothing (affiliation changed). */
  casResult?: { id: string } | null;
  auditError?: { message: string } | null;
}) {
  const from = db.from as unknown as ReturnType<typeof vi.fn>;
  const calls: { table: string; filters: Record<string, unknown>; op: string }[] = [];
  from.mockImplementation((table: string) => {
    if (table === 'audit_events') {
      return { insert: () => Promise.resolve({ error: opts.auditError ?? null }) };
    }
    if (table === 'org_credits') {
      const c: Record<string, unknown> = {};
      c.select = () => c; c.eq = () => c;
      c.maybeSingle = () => Promise.resolve({ data: { balance: 0 }, error: null });
      return c;
    }
    if (table !== 'organizations') throw new Error(`unexpected table ${table}`);

    const filters: Record<string, unknown> = {};
    let op = 'select';
    let columns = '';
    const chain: Record<string, unknown> = {};
    chain.select = (cols?: string) => { if (cols) columns = cols; return chain; };
    chain.update = () => { op = 'update'; return chain; };
    chain.eq = (col: string, value: unknown) => { filters[col] = value; return chain; };
    chain.is = (col: string, value: unknown) => { filters[col] = value; return chain; };
    chain.order = () => {
      calls.push({ table, filters, op: 'list' });
      return Promise.resolve({ data: [opts.child], error: null });
    };
    // The cap count is awaited directly (no `.maybeSingle()`).
    chain.then = (resolve: (v: unknown) => unknown) => {
      calls.push({ table, filters, op: 'cap_count' });
      return Promise.resolve({ data: opts.capChildren ?? [], error: null }).then(resolve);
    };
    chain.maybeSingle = () => {
      calls.push({ table, filters, op });
      if (op === 'update') {
        return Promise.resolve({ data: opts.casResult === undefined ? { id: CHILD } : opts.casResult, error: null });
      }
      if (columns.includes('max_sub_orgs')) {
        return Promise.resolve({ data: { max_sub_orgs: opts.maxSubOrgs ?? 20 }, error: null });
      }
      if (filters.public_id !== undefined) {
        const matches = Object.entries(filters).every(
          ([k, v]) => (opts.child as unknown as Record<string, unknown>)[k] === v,
        );
        return Promise.resolve({ data: matches ? opts.child : null, error: null });
      }
      // The acting-organization lookup.
      return Promise.resolve({ data: ACTING_PARENT, error: null });
    };
    return chain;
  });
  return calls;
}

const rpc = () => db.rpc as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  (db.from as unknown as ReturnType<typeof vi.fn>).mockReset();
  rpc().mockReset();
});

const WRITE_ROUTES: [string, string, Record<string, unknown>][] = [
  ['post', '/approve', { org_public_id: CHILD_PUB }],
  ['post', '/revoke', { org_public_id: CHILD_PUB }],
  ['post', '/credits', { org_public_id: CHILD_PUB, amount: 10 }],
  ['post', '/offboard', { org_public_id: CHILD_PUB }],
];

describe('authentication and scope', () => {
  it.each([
    ['get', '/'],
    ['get', '/credits'],
    ...WRITE_ROUTES.map(([m, p]) => [m, p] as [string, string]),
  ])('401s %s %s with no API key at all', async (method, path) => {
    mockDb();
    const app = buildApp(null);
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](
      `/api/v1/organizations/sub-orgs${path}`,
    ).send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('authentication_required');
  });

  it.each(WRITE_ROUTES)('403s %s %s for a key holding only read:orgs', async (method, path, body) => {
    mockDb();
    const app = buildApp(['read:orgs']);
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](
      `/api/v1/organizations/sub-orgs${path}`,
    ).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required).toBe('orgs:manage');
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('admits a key holding ONLY orgs:manage to a read route (orgs:manage ⊇ read:orgs)', async () => {
    mockDb({ children: [APPROVED_CHILD] });
    const res = await request(buildApp(['orgs:manage'])).get('/api/v1/organizations/sub-orgs');
    expect(res.status).toBe(200);
  });

  /**
   * U2. `get_parent_credit_rollup_as_api_key` requires `orgs:manage` in SQL
   * (0453 -> `_suborg_api_key_authorized`), so a route gated on `read:orgs`
   * published a contract the database refuses: the key reached the RPC and got
   * a permanent `parent_admin_required` it could not distinguish from a real
   * authority failure. The refusal belongs at the gate, and BEFORE the RPC.
   */
  it('403s GET /credits for a read:orgs key, before the RPC is ever called', async () => {
    mockDb();
    const res = await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs/credits');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required).toBe('orgs:manage');
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('still admits GET / (the directory read) to a read:orgs key', async () => {
    mockDb({ children: [APPROVED_CHILD] });
    const res = await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs');
    expect(res.status).toBe(200);
  });
});

describe('GET / — list', () => {
  it('returns children by public id with the cap and count', async () => {
    mockDb({ children: [APPROVED_CHILD], markers: [{ org_id: CHILD }] });
    const res = await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sub_orgs: [{
        public_id: CHILD_PUB,
        display_name: 'Client A',
        domain: 'client-a.example',
        verification_status: 'VERIFIED',
        parent_approval_status: 'APPROVED',
        suspended: false,
        docusign_inherited: true,
        created_at: '2026-01-01T00:00:00.000Z',
      }],
      max_sub_orgs: 20,
      count: 1,
    });
  });

  it('503s when the DocuSign-marker lookup fails instead of reporting "nobody is inheriting"', async () => {
    mockDb({ children: [APPROVED_CHILD], markersError: { message: 'boom' } });
    const res = await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('sub_org_list_unavailable');
  });

  it('503s when the child list itself fails', async () => {
    mockDb({ childrenError: { message: 'boom' } });
    const res = await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs');
    expect(res.status).toBe(503);
  });
});

describe('selector validation', () => {
  it.each(WRITE_ROUTES)('400s %s %s when the selector is a raw uuid', async (method, path, body) => {
    mockDb();
    const app = buildApp(['orgs:manage']);
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](
      `/api/v1/organizations/sub-orgs${path}`,
    ).send({ ...body, org_public_id: CHILD });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('use_public_id');
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('422s a missing selector', async () => {
    mockDb();
    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/approve').send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid_request');
  });

  it('404s a child that belongs to another parent', async () => {
    mockDb({ children: [{ ...APPROVED_CHILD, parent_org_id: 'someone-else' }] });
    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits')
      .send({ org_public_id: CHILD_PUB, amount: 5 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('sub_org_not_found');
    expect(rpc()).not.toHaveBeenCalled();
  });
});

describe('acting organization', () => {
  it('403s a key whose own organization is itself an affiliate', async () => {
    mockDb({ organizations: [{ id: PARENT, parent_org_id: 'a-grandparent' }] });
    const res = await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('sub_org_cannot_manage_sub_orgs');
  });
});

describe('write routes — happy paths', () => {
  it('approves a pending child and echoes only its public id', async () => {
    mockDb({ children: [{ ...APPROVED_CHILD, parent_approval_status: 'PENDING' }] });
    // updateAffiliateStatus: cap read, cap children read, scoped CAS update, audit insert.
    const from = db.from as unknown as ReturnType<typeof vi.fn>;
    const base = from.getMockImplementation() as (table: string) => unknown;
    let organizationsCall = 0;
    from.mockImplementation((table: string) => {
      if (table === 'audit_events') return { insert: () => Promise.resolve({ error: null }) };
      if (table === 'organizations') {
        organizationsCall += 1;
        // 1: acting org, 2: child resolve, 3: cap max_sub_orgs, 4: cap children, 5: CAS update
        if (organizationsCall === 3) {
          const c: Record<string, unknown> = {};
          c.select = () => c; c.eq = () => c;
          c.maybeSingle = () => Promise.resolve({ data: { max_sub_orgs: 20 }, error: null });
          return c;
        }
        if (organizationsCall === 4) {
          const c: Record<string, unknown> = {};
          c.select = () => c;
          c.eq = () => c;
          c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
          return c;
        }
        if (organizationsCall === 5) {
          const c: Record<string, unknown> = {};
          c.update = () => c; c.eq = () => c; c.is = () => c; c.select = () => c;
          c.maybeSingle = () => Promise.resolve({ data: { id: CHILD }, error: null });
          return c;
        }
      }
      return base(table);
    });

    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/approve')
      .send({ org_public_id: CHILD_PUB });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'APPROVED', public_id: CHILD_PUB });
  });

  it('allocates credits through the *_as_api_key RPC with the KEY id, never a user id', async () => {
    mockDb({ children: [APPROVED_CHILD] });
    rpc().mockResolvedValueOnce({ data: { success: true, parent_balance: 60, child_balance: 40 }, error: null });

    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits')
      .send({ org_public_id: CHILD_PUB, amount: 40, note: 'initial' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parent_balance: 60, child_balance: 40, amount: 40 });
    expect(rpc()).toHaveBeenCalledWith('allocate_credits_to_sub_org_as_api_key', {
      p_parent_org_id: PARENT,
      p_child_org_id: CHILD,
      p_amount: 40,
      p_note: 'initial',
      p_caller_api_key_id: KEY_ID,
    });
    const [, args] = rpc().mock.calls[0];
    expect(Object.keys(args)).not.toContain('p_caller_user_id');
  });

  it('surfaces the 0447 cap trigger as a 409, not a 500', async () => {
    mockDb({ children: [APPROVED_CHILD] });
    rpc().mockResolvedValueOnce({ data: { error: 'not_a_sub_org' }, error: null });
    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits')
      .send({ org_public_id: CHILD_PUB, amount: 5 });
    expect(res.status).toBe(404);

    mockDb({ children: [APPROVED_CHILD] });
    rpc().mockReset();
    rpc().mockResolvedValueOnce({ data: { error: 'insufficient_parent_balance' }, error: null });
    const res2 = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits')
      .send({ org_public_id: CHILD_PUB, amount: 5 });
    expect(res2.status).toBe(409);
  });

  it('offboards a suspended child (idempotent retry) and returns snake_case only', async () => {
    mockDb({ children: [{ ...APPROVED_CHILD, suspended: true }], creditBalance: 0 });
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 0, already_suspended: true }, error: null });

    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/offboard')
      .send({ org_public_id: CHILD_PUB, reason: 'engagement ended' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reclaimed: 0, suspended: true, already_suspended: true });
    expect(rpc()).toHaveBeenCalledExactlyOnceWith('offboard_suborg_as_api_key', {
      p_parent_org_id: PARENT,
      p_sub_org_id: CHILD,
      p_reason: 'engagement ended',
      p_caller_api_key_id: KEY_ID,
    });
  });

  it('returns the credit rollup keyed by child public id', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({
      data: {
        parent_org_id: PARENT,
        parent_balance: 100,
        children: [{ child_org_id: CHILD, child_public_id: CHILD_PUB, balance: 40, monthly_allocation: 10 }],
      },
      error: null,
    });

    const res = await request(buildApp(['orgs:manage'])).get('/api/v1/organizations/sub-orgs/credits');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      parent_balance: 100,
      children: [{ public_id: CHILD_PUB, balance: 40, monthly_allocation: 10 }],
    });
  });

  it('503s the rollup rather than under-reporting when a child has no public id', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({
      data: {
        parent_org_id: PARENT,
        parent_balance: 100,
        children: [{ child_org_id: CHILD, balance: 40, monthly_allocation: 10 }],
      },
      error: null,
    });
    const res = await request(buildApp(['orgs:manage'])).get('/api/v1/organizations/sub-orgs/credits');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('rollup_projection_unavailable');
  });
});

/**
 * U1 — the two documented wind-down orders must BOTH be drivable from this
 * surface. Each case is a route call, not a predicate unit test, because the
 * defect was in which resolver the route picked.
 */
describe('lifecycle on the key surface', () => {
  function post(path: string, body: Record<string, unknown>) {
    return request(buildApp(['orgs:manage'])).post(`/api/v1/organizations/sub-orgs${path}`).send(body);
  }

  it('approves a PENDING affiliate', async () => {
    mockStatusActionDb({ child: { ...APPROVED_CHILD, parent_approval_status: 'PENDING' } });
    const res = await post('/approve', { org_public_id: CHILD_PUB });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'APPROVED', public_id: CHILD_PUB });
  });

  it('404s approve on an already-APPROVED affiliate — approve is the PENDING transition', async () => {
    mockStatusActionDb({ child: APPROVED_CHILD });
    const res = await post('/approve', { org_public_id: CHILD_PUB });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('sub_org_not_found');
  });

  it('offboard then revoke: revoking a suspended affiliate still works', async () => {
    mockStatusActionDb({ child: { ...APPROVED_CHILD, suspended: true } });
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 0, already_suspended: false }, error: null });
    const offboard = await post('/offboard', { org_public_id: CHILD_PUB });
    expect(offboard.status).toBe(200);

    mockStatusActionDb({ child: { ...APPROVED_CHILD, suspended: true } });
    const revoke = await post('/revoke', { org_public_id: CHILD_PUB });
    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ status: 'REVOKED', public_id: CHILD_PUB });
  });

  it('revoke then offboard: offboarding a REVOKED affiliate still reclaims and suspends', async () => {
    mockStatusActionDb({ child: { ...APPROVED_CHILD, parent_approval_status: 'REVOKED' } });
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 0, already_suspended: false }, error: null });
    const res = await post('/offboard', { org_public_id: CHILD_PUB, reason: 'ended' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reclaimed: 0, suspended: true, already_suspended: false });
  });

  it('404s revoke on an already-REVOKED affiliate', async () => {
    mockStatusActionDb({ child: { ...APPROVED_CHILD, parent_approval_status: 'REVOKED' } });
    const res = await post('/revoke', { org_public_id: CHILD_PUB });
    expect(res.status).toBe(404);
  });

  /**
   * U4. The audit insert used to be fire-and-forget, so a failed insert
   * answered 200 with no record of the transition. On this surface `actor_id`
   * is NULL by construction, so `details.actor` is the ONLY attribution that
   * exists — a swallowed insert is an affiliation that changed with no
   * attributable actor.
   */
  it('500s audit_write_failed when the audit insert fails, instead of answering 200', async () => {
    mockStatusActionDb({
      child: { ...APPROVED_CHILD, parent_approval_status: 'PENDING' },
      auditError: { message: 'audit table unavailable' },
    });
    const res = await post('/approve', { org_public_id: CHILD_PUB });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('audit_write_failed');
  });

  /**
   * U6. The shared core answers the dashboard with English sentences —
   * "Affiliated-organization limit reached (1 of 1)." carries a live COUNT.
   * This surface is frozen on publication (§1.8), so it publishes machine
   * codes and the status `docs.ts` documents (409 for a state conflict, not
   * the core's 400).
   */
  it('publishes sub_org_limit_reached as a 409 code, never the counted sentence', async () => {
    mockStatusActionDb({
      child: { ...APPROVED_CHILD, parent_approval_status: 'PENDING' },
      maxSubOrgs: 1,
      capChildren: [{ id: CHILD }],
    });
    const res = await post('/approve', { org_public_id: CHILD_PUB });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sub_org_limit_reached');
    expect(JSON.stringify(res.body)).not.toMatch(/Affiliated-organization limit/);
  });

  it('publishes the compare-and-set miss as 409 affiliation_changed, not prose', async () => {
    mockStatusActionDb({
      child: { ...APPROVED_CHILD, parent_approval_status: 'PENDING' },
      casResult: null,
    });
    const res = await post('/approve', { org_public_id: CHILD_PUB });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('affiliation_changed');
    expect(JSON.stringify(res.body)).not.toMatch(/Refresh and try again/);
  });

  it('404s credits on a suspended affiliate — money never moves into a dead affiliation', async () => {
    mockStatusActionDb({ child: { ...APPROVED_CHILD, suspended: true } });
    const res = await post('/credits', { org_public_id: CHILD_PUB, amount: 5 });
    expect(res.status).toBe(404);
    expect(rpc()).not.toHaveBeenCalled();
  });
});

/**
 * R11 — the sweep. Not a spot-check of fields somebody remembered: every
 * response body produced by this surface, walked to the leaves. `public_id` is
 * the ONLY key allowed to end in `_id`, and no VALUE anywhere may look like a
 * uuid, camelCase included.
 */
function sweep(value: unknown, path: string, findings: string[]): void {
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) findings.push(`${path} = ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => sweep(entry, `${path}[${i}]`, findings));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key !== 'public_id' && (/_id$/.test(key) || /OrgId$/.test(key))) {
        findings.push(`${path}.${key} — key names an internal identifier`);
      }
      sweep(entry, `${path}.${key}`, findings);
    }
  }
}

/**
 * U7. `api_key_principal_unresolved` is a code only 0453's `*_as_api_key`
 * functions can return, and neither status map listed it, so it fell through
 * to a bare 500 — "our bug, retry" for a refusal the database chose. Any other
 * unmapped structured refusal is a 502 for the same reason: the call was
 * answered upstream, not dropped here.
 */
describe('RPC codes this worker version does not name (U7)', () => {
  it('503s api_key_principal_unresolved on POST /credits instead of 500', async () => {
    mockDb({ children: [APPROVED_CHILD] });
    rpc().mockResolvedValueOnce({ data: { error: 'api_key_principal_unresolved' }, error: null });
    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits')
      .send({ org_public_id: CHILD_PUB, amount: 5 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('api_key_principal_unresolved');
  });

  it('502s, not 500s, a structured refusal the status map has never heard of', async () => {
    mockDb({ children: [APPROVED_CHILD] });
    rpc().mockResolvedValueOnce({ data: { error: 'some_future_sql_code' }, error: null });
    const res = await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits')
      .send({ org_public_id: CHILD_PUB, amount: 5 });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('some_future_sql_code');
  });

  it('503s api_key_principal_unresolved on GET /credits', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({ data: { error: 'api_key_principal_unresolved' }, error: null });
    const res = await request(buildApp(['orgs:manage'])).get('/api/v1/organizations/sub-orgs/credits');
    expect(res.status).toBe(503);
  });
});

/**
 * U13. `resolveSubOrgCaller` reads and 403s on the acting organization, so a
 * miss in the cap read is that row disappearing mid-request. `?? null` reported
 * it as "no affiliate cap" — an unlimited-looking answer derived from a row
 * that is gone.
 */
describe('the acting organization cannot vanish into a null cap (U13)', () => {
  it('503s the list when the cap read finds no acting organization', async () => {
    const from = db.from as unknown as ReturnType<typeof vi.fn>;
    let organizationsCall = 0;
    from.mockImplementation((table: string) => {
      if (table !== 'organizations') throw new Error(`unexpected table ${table}`);
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => Promise.resolve({ data: [], error: null });
      chain.maybeSingle = () => {
        organizationsCall += 1;
        // 1st = resolveSubOrgCaller's acting-org read (present);
        // 2nd = the cap read, after the row has gone.
        return Promise.resolve({ data: organizationsCall === 1 ? ACTING_PARENT : null, error: null });
      };
      return chain;
    });

    const res = await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('sub_org_list_unavailable');
  });
});

describe('no raw uuid escapes this surface (R11)', () => {
  it('sweeps every route response recursively', async () => {
    const bodies: Record<string, unknown> = {};

    mockDb({ children: [APPROVED_CHILD], markers: [{ org_id: CHILD }] });
    bodies['GET /'] = (await request(buildApp(['read:orgs'])).get('/api/v1/organizations/sub-orgs')).body;

    mockDb();
    rpc().mockResolvedValueOnce({
      data: {
        parent_org_id: PARENT, parent_balance: 100,
        children: [{ child_org_id: CHILD, child_public_id: CHILD_PUB, balance: 40, monthly_allocation: 10 }],
      },
      error: null,
    });
    bodies['GET /credits'] = (await request(buildApp(['orgs:manage']))
      .get('/api/v1/organizations/sub-orgs/credits')).body;

    mockDb({ children: [APPROVED_CHILD] });
    rpc().mockReset();
    rpc().mockResolvedValueOnce({ data: { success: true, parent_balance: 1, child_balance: 2 }, error: null });
    bodies['POST /credits'] = (await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits').send({ org_public_id: CHILD_PUB, amount: 1 })).body;

    mockDb({ children: [{ ...APPROVED_CHILD, suspended: true }], creditBalance: 0 });
    rpc().mockReset();
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 0, already_suspended: true }, error: null });
    bodies['POST /offboard'] = (await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/offboard').send({ org_public_id: CHILD_PUB })).body;

    // Error bodies count too — a 404 that echoes the uuid it refused is a leak.
    mockDb({ children: [{ ...APPROVED_CHILD, parent_org_id: 'someone-else' }] });
    bodies['POST /credits 404'] = (await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/credits').send({ org_public_id: CHILD_PUB, amount: 1 })).body;

    mockDb();
    bodies['POST /approve 400'] = (await request(buildApp(['orgs:manage']))
      .post('/api/v1/organizations/sub-orgs/approve').send({ org_public_id: CHILD })).body;

    const findings: string[] = [];
    for (const [route, body] of Object.entries(bodies)) {
      expect(body, `${route} produced an empty body — the sweep would pass vacuously`).toBeTruthy();
      sweep(body, route, findings);
    }
    expect(findings).toEqual([]);
  });
});
