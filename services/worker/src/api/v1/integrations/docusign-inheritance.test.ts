/**
 * SCRUM-3867 — DocuSign connection inheritance, write path.
 *
 * Pre-mortem F5: migration 0328 added `org_integrations.inherited_from_org_id`,
 * the resolver, the webhook and queue reconciliation all READ it — and nothing
 * in the codebase has ever WRITTEN one. Production has zero markers. These
 * endpoints are the missing write path.
 *
 * Authorization is on the PARENT, not the child. A marker makes the sub-org's
 * envelopes run on the parent's DocuSign credentials, so the party lending
 * something is the parent; the child only receives a capability. Same shape as
 * credit allocation, where the parent admin acts on the child.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The module imports the shared client for its default; loading it for real
// would validate the whole worker config. Every router in this folder is
// dependency-injected for exactly this reason — the tests pass their own db.
vi.mock('../../../utils/db.js', () => ({ db: {} }));
vi.mock('../../../config.js', () => ({ config: {} }));

import { createDocusignInheritanceRouter } from './docusign-inheritance.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';

interface Fixture {
  /** organizations rows keyed by id */
  orgs?: Record<string, { parent_org_id: string | null }>;
  /** org_members rows: `${userId}:${orgId}` -> role */
  members?: Record<string, string>;
  /** live org_integrations docusign rows keyed by org_id */
  integrations?: Record<string, { id: string; inherited_from_org_id: string | null; revoked_at?: string | null }>;
  additionalIntegrations?: Record<string, NonNullable<Fixture['integrations']>[string][]>;
  rpcError?: boolean;
  beforeIntegrationUpdate?: (rows: NonNullable<Fixture['integrations']>) => void;
  orgsError?: boolean;
  profiles?: Record<string, { org_id: string | null; role: string; is_platform_admin: boolean }>;
  profileError?: boolean;
}

/** Minimal supabase-shaped stub covering only the queries this router issues. */
function makeDb(fx: Fixture) {
  const inserted: Record<string, unknown>[] = [];
  const updated: { id: string; patch: Record<string, unknown> }[] = [];

  const db = {
    from(table: string) {
      if (table === 'profiles') {
        let id = '';
        const chain = {
          select: () => chain,
          eq: (_column: string, value: string) => { id = value; return chain; },
          maybeSingle: async () => ({
            data: fx.profileError ? null : fx.profiles?.[id] ?? null,
            error: fx.profileError ? { message: 'profile lookup unavailable' } : null,
          }),
        };
        return chain;
      }
      if (table === 'organizations') {
        let id = '';
        const chain = {
          select: () => chain,
          eq: (_c: string, v: string) => { id = v; return chain; },
          maybeSingle: async () =>
            fx.orgsError
              ? { data: null, error: { message: 'boom' } }
              : { data: fx.orgs?.[id] ?? null, error: null },
        };
        return chain;
      }
      if (table === 'org_members') {
        let userId = '';
        let orgId = '';
        const chain = {
          select: () => chain,
          eq: (col: string, v: string) => {
            if (col === 'user_id') userId = v; else orgId = v;
            return chain;
          },
          maybeSingle: async () => ({
            data: fx.members?.[`${userId}:${orgId}`]
              ? { role: fx.members[`${userId}:${orgId}`] }
              : null,
            error: null,
          }),
        };
        return chain;
      }
      if (table === 'org_integrations') {
        let orgId = '';
        let inherited: boolean | undefined;
        let limit = Infinity;
        const chain = {
          select: () => chain,
          eq: (col: string, v: string) => { if (col === 'org_id') orgId = v; return chain; },
          is: (col: string) => { if (col === 'inherited_from_org_id') inherited = false; return chain; },
          not: (col: string) => { if (col === 'inherited_from_org_id') inherited = true; return chain; },
          limit: (value: number) => { limit = value; return chain; },
          maybeSingle: async () => {
            const candidates = [fx.integrations?.[orgId], ...(fx.additionalIntegrations?.[orgId] ?? [])]
              .filter((row) => row && !row.revoked_at && (inherited === undefined || (row.inherited_from_org_id !== null) === inherited))
              .slice(0, limit);
            if (candidates.length > 1) return { data: null, error: { code: 'PGRST116', message: 'Multiple rows returned' } };
            return { data: candidates[0] ? { ...candidates[0] } : null, error: null };
          },
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: 'marker-1', ...row }, error: null }),
              }),
            };
          },
          update: (patch: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {};
            const execute = () => {
              const rows = fx.integrations ?? {};
              fx.beforeIntegrationUpdate?.(rows);
              const match = Object.entries(rows).find(([rowOrgId, row]) => {
                const current = { provider: 'docusign', revoked_at: null, ...row, org_id: rowOrgId };
                return Object.entries(filters).every(([key, value]) => current[key as keyof typeof current] === value);
              });
              if (!match) return { data: null, error: null };
              const [, row] = match;
              updated.push({ id: row.id, patch });
              Object.assign(row, patch);
              return { data: { id: row.id }, error: null };
            };
            const upd = {
              eq: (col: string, v: string) => {
                filters[col] = v;
                return upd;
              },
              is: (col: string, v: null) => { filters[col] = v; return upd; },
              select: () => ({ maybeSingle: async () => execute() }),
              then: (resolve: (value: ReturnType<typeof execute>) => unknown) => Promise.resolve(execute()).then(resolve),
            };
            return upd;
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(name: string, args: Record<string, string>) {
      if (name !== 'stop_suborg_docusign_inheritance') throw new Error(`unexpected RPC ${name}`);
      if (fx.rpcError) return { data: null, error: { code: '55P03', message: 'lock timeout' } };
      const rows = fx.integrations ?? {};
      fx.beforeIntegrationUpdate?.(rows);
      if (fx.orgs?.[args.p_child_org_id]?.parent_org_id !== args.p_parent_org_id) {
        return { data: { error: 'child_parent_changed' }, error: null };
      }
      const member = fx.members?.[`${args.p_caller_user_id}:${args.p_parent_org_id}`];
      const profile = fx.profiles?.[args.p_caller_user_id];
      const allowed = ['owner', 'admin', 'ORG_ADMIN'].includes(member ?? '') || profile?.is_platform_admin ||
        (profile?.org_id === args.p_parent_org_id && profile?.role === 'ORG_ADMIN');
      if (!allowed) return { data: { error: 'parent_admin_required' }, error: null };
      const row = rows[args.p_child_org_id];
      if (!row || row.id !== args.p_integration_id || row.inherited_from_org_id !== args.p_inherited_from_org_id || row.revoked_at) {
        return { data: { error: 'inherited_connection_changed' }, error: null };
      }
      const patch = { revoked_at: args.p_revoked_at };
      Object.assign(row, patch);
      updated.push({ id: row.id, patch });
      return { data: { success: true }, error: null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, inserted, updated };
}

function buildApp(fx: Fixture, userId?: string) {
  const { db, inserted, updated } = makeDb(fx);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) (req as unknown as { userId: string }).userId = userId;
    next();
  });
  app.use('/api/v1/integrations', createDocusignInheritanceRouter({ db }));
  return { app, inserted, updated };
}

/** The ordinary happy-path world: CHILD under PARENT, PARENT connected. */
const CONNECTED: Fixture = {
  orgs: { [CHILD]: { parent_org_id: PARENT }, [PARENT]: { parent_org_id: null } },
  members: { [`${ADMIN}:${PARENT}`]: 'owner' },
  integrations: { [PARENT]: { id: 'int-parent', inherited_from_org_id: null } },
};

describe('parent administration through the canonical profile fallback', () => {
  it.each([
    ['/docusign/inherit', 201],
    ['/docusign/inherit/stop', 200],
  ])('recognizes the parent profile owner without an org_members row on %s', async (path, expectedStatus) => {
    const { app } = buildApp({
      ...CONNECTED,
      members: {},
      profiles: { [ADMIN]: { org_id: PARENT, role: 'ORG_ADMIN', is_platform_admin: false } },
      integrations: path.endsWith('/stop')
        ? { [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT } }
        : CONNECTED.integrations,
    }, ADMIN);
    const res = await request(app).post('/api/v1/integrations' + path).send({ org_id: CHILD });
    expect(res.status).toBe(expectedStatus);
  });

  it('keeps the profile administrator role scoped to its own organization', async () => {
    const { app, inserted } = buildApp({ ...CONNECTED, members: {}, profiles: {
      [ADMIN]: { org_id: OTHER, role: 'ORG_ADMIN', is_platform_admin: false },
    } }, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit').send({ org_id: CHILD });
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('reports a profile lookup outage without allowing a write', async () => {
    const { app, inserted } = buildApp({ ...CONNECTED, members: {}, profileError: true }, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit').send({ org_id: CHILD });
    expect(res.status).toBe(503);
    expect(inserted).toHaveLength(0);
  });
});

describe('POST /docusign/inherit (SCRUM-3867)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401s without a session', async () => {
    const { app } = buildApp(CONNECTED);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit').send({ org_id: CHILD });
    expect(res.status).toBe(401);
  });

  it('400s on a body that is not a uuid', async () => {
    const { app } = buildApp(CONNECTED, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: 'nope' });
    expect(res.status).toBe(400);
  });

  it('creates a credential-free marker pointing at the parent', async () => {
    const { app, inserted } = buildApp(CONNECTED, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      org_id: CHILD,
      provider: 'docusign',
      inherited_from_org_id: PARENT,
      // 0328's CHECK constraint: a marker carries no credentials of its own.
      account_id: null,
      encrypted_tokens: null,
      token_secret_name: null,
    });
  });

  it('403s a caller who administers the child but not the parent', async () => {
    // The parent is lending its credentials, so the parent authorizes. A child
    // admin must not be able to help themselves to the parent's connection.
    const { app, inserted } = buildApp({
      ...CONNECTED,
      members: { [`${ADMIN}:${CHILD}`]: 'owner' },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('403s a non-admin member of the parent', async () => {
    const { app } = buildApp({
      ...CONNECTED,
      members: { [`${ADMIN}:${PARENT}`]: 'member' },
    }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(403);
  });

  it('409s when the target org has no parent', async () => {
    const { app } = buildApp({
      ...CONNECTED,
      orgs: { [CHILD]: { parent_org_id: null } },
    }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_a_sub_org');
  });

  it('409s when the parent has no DocuSign connection to lend', async () => {
    const { app, inserted } = buildApp({ ...CONNECTED, integrations: {} }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('parent_not_connected');
    expect(inserted).toHaveLength(0);
  });

  it('409s rather than chaining when the parent is itself inheriting', async () => {
    // The resolver refuses to chain, so a marker pointing at a marker would be
    // a connection that silently resolves to nothing.
    const { app, inserted } = buildApp({
      ...CONNECTED,
      integrations: { [PARENT]: { id: 'int-parent', inherited_from_org_id: OTHER } },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('parent_inherits');
    expect(inserted).toHaveLength(0);
  });

  it('409s when the child already holds its own connection', async () => {
    const { app, inserted } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'int-child', inherited_from_org_id: null },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_connected');
    expect(inserted).toHaveLength(0);
  });

  it('is idempotent when the marker already exists', async () => {
    const { app, inserted } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });

    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(0);
  });

  it('503s when the org lookup fails, rather than reading as not-a-sub-org', async () => {
    const { app } = buildApp({ ...CONNECTED, orgsError: true }, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit')
      .send({ org_id: CHILD });
    expect(res.status).toBe(503);
  });
});

describe('POST /docusign/inherit/stop (SCRUM-3867)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['converted to an own connection', (rows: NonNullable<Fixture['integrations']>) => { rows[CHILD].inherited_from_org_id = null; }],
    ['moved to a different parent', (rows: NonNullable<Fixture['integrations']>) => { rows[CHILD].inherited_from_org_id = OTHER; }],
    ['already revoked', (rows: NonNullable<Fixture['integrations']>) => { rows[CHILD].revoked_at = '2026-09-05T16:00:00.000Z'; }],
    ['deleted', (rows: NonNullable<Fixture['integrations']>) => { delete rows[CHILD]; }],
  ])('does not revoke a marker %s after the authorization read', async (_name, change) => {
    const fx: Fixture = {
      ...CONNECTED,
      integrations: { [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT } },
      beforeIntegrationUpdate: change,
    };
    const { app, updated } = buildApp(fx, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit/stop').send({ org_id: CHILD });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'inherited_connection_changed' });
    expect(updated).toHaveLength(0);
  });

  it('revokes the marker', async () => {
    const { app, updated } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit/stop')
      .send({ org_id: CHILD });

    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(updated[0].patch).toHaveProperty('revoked_at');
  });

  it('404s when there is no marker to stop', async () => {
    const { app, updated } = buildApp(CONNECTED, ADMIN);
    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit/stop')
      .send({ org_id: CHILD });
    expect(res.status).toBe(404);
    expect(updated).toHaveLength(0);
  });

  it('refuses to revoke an org OWN connection through this endpoint', async () => {
    // Disconnecting a real connection is /docusign/disconnect's job — it also
    // deletes the refresh-token secret. Revoking it here would orphan that
    // secret in Secret Manager.
    const { app, updated } = buildApp({
      ...CONNECTED,
      integrations: {
        [PARENT]: { id: 'int-parent', inherited_from_org_id: null },
        [CHILD]: { id: 'int-child', inherited_from_org_id: null },
      },
    }, ADMIN);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/inherit/stop')
      .send({ org_id: CHILD });

    expect(res.status).toBe(404);
    expect(updated).toHaveLength(0);
  });
});

describe('DocuSign multi-account and transactional stop regressions', () => {
  it('can inherit from a parent with two owned accounts', async () => {
    const { app, inserted } = buildApp({ ...CONNECTED,
      additionalIntegrations: { [PARENT]: [{ id: 'second-parent-account', inherited_from_org_id: null }] },
    }, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit').send({ org_id: CHILD });
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
  });

  it('keeps an existing owned connection authoritative over a coexisting marker', async () => {
    const { app, inserted } = buildApp({ ...CONNECTED,
      integrations: { [CHILD]: { id: 'child-owned', inherited_from_org_id: null } },
      additionalIntegrations: { [CHILD]: [{ id: 'marker-1', inherited_from_org_id: PARENT }] },
    }, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit').send({ org_id: CHILD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_connected');
    expect(inserted).toHaveLength(0);
  });

  it('stops only the marker when the child also has an owned account', async () => {
    const own = { id: 'child-owned', inherited_from_org_id: null };
    const { app, updated } = buildApp({ ...CONNECTED,
      integrations: { [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT } },
      additionalIntegrations: { [CHILD]: [own] },
    }, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit/stop').send({ org_id: CHILD });
    expect(res.status).toBe(200);
    expect(updated.map((row) => row.id)).toEqual(['marker-1']);
    expect(own).not.toHaveProperty('revoked_at');
  });

  it('rejects an old parent after a committed child reparent', async () => {
    const fx: Fixture = { ...CONNECTED, orgs: { [CHILD]: { parent_org_id: PARENT } },
      integrations: { [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT } },
      beforeIntegrationUpdate: () => { fx.orgs![CHILD].parent_org_id = OTHER; },
    };
    const { app, updated } = buildApp(fx, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit/stop').send({ org_id: CHILD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('child_parent_changed');
    expect(updated).toHaveLength(0);
  });

  it('rechecks parent administration before committing the revocation', async () => {
    const fx: Fixture = { ...CONNECTED, members: { [`${ADMIN}:${PARENT}`]: 'owner' },
      integrations: { [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT } },
      beforeIntegrationUpdate: () => { fx.members![`${ADMIN}:${PARENT}`] = 'member'; },
    };
    const { app, updated } = buildApp(fx, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit/stop').send({ org_id: CHILD });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('parent_admin_required');
    expect(updated).toHaveLength(0);
  });

  it('reports a transactional stop outage without claiming success', async () => {
    const { app, updated } = buildApp({ ...CONNECTED, rpcError: true,
      integrations: { [CHILD]: { id: 'marker-1', inherited_from_org_id: PARENT } },
    }, ADMIN);
    const res = await request(app).post('/api/v1/integrations/docusign/inherit/stop').send({ org_id: CHILD });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('inheritance_write_unavailable');
    expect(updated).toHaveLength(0);
  });
});
